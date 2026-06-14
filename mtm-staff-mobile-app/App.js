import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { supabase } from "./src/supabase";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true
  })
});

const emptySalesState = { parties: [], misc: [], orders: [], agents: [], staffs: [] };

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function displayDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function getOrderTotal(order) {
  return (order.colors || []).reduce((sum, row) => sum + Number(row.qty || 0), 0);
}

function getBaleSent(order) {
  return (order.bales || []).reduce((sum, bale) => sum + Number(bale.totalQty || 0), 0);
}

function getPendingRows(order) {
  const usedByColor = {};
  (order.bales || []).forEach((bale) => {
    (bale.colors || []).forEach((row) => {
      const key = String(row.colorNo || "").trim();
      usedByColor[key] = (usedByColor[key] || 0) + Number(row.qty || 0);
    });
  });
  return (order.colors || []).map((row) => {
    const colorNo = String(row.colorNo || "").trim();
    const ordered = Number(row.qty || 0);
    const sent = Number(usedByColor[colorNo] || 0);
    return {
      colorNo,
      ordered,
      sent,
      pending: ordered - sent
    };
  });
}

function AppButton({ title, onPress, tone = "primary", disabled = false }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        tone === "danger" && styles.buttonDanger,
        tone === "ghost" && styles.buttonGhost,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed
      ]}
    >
      <Text style={[styles.buttonText, tone === "ghost" && styles.buttonGhostText]}>{title}</Text>
    </Pressable>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);
  const [salesState, setSalesState] = useState(emptySalesState);
  const [selectedOrderId, setSelectedOrderId] = useState(null);
  const [packingQty, setPackingQty] = useState({});
  const [notifications, setNotifications] = useState([]);
  const [query, setQuery] = useState("");
  const previousAssignedIds = useRef(new Set());

  const staffEmail = normalize(session?.user?.email);

  const assignedOrders = useMemo(() => {
    return (salesState.orders || [])
      .filter((order) => normalize(order.assignedStaff) === staffEmail)
      .sort((a, b) => String(a.mtmOrderNo || "").localeCompare(String(b.mtmOrderNo || ""), undefined, { numeric: true }));
  }, [salesState.orders, staffEmail]);

  const filteredOrders = useMemo(() => {
    const q = normalize(query);
    if (!q) return assignedOrders;
    return assignedOrders.filter((order) => {
      const text = [
        order.mtmOrderNo,
        order.partyOrderNo,
        order.partyName,
        order.agentName,
        order.quality,
        order.packing,
        order.patta,
        order.stamping,
        order.transport,
        order.status
      ].join(" ");
      return normalize(text).includes(q);
    });
  }, [assignedOrders, query]);

  const selectedOrder = useMemo(
    () => assignedOrders.find((order) => String(order.id) === String(selectedOrderId)) || null,
    [assignedOrders, selectedOrderId]
  );

  const selectedTotal = useMemo(
    () => Object.values(packingQty).reduce((sum, value) => sum + Number(value || 0), 0),
    [packingQty]
  );

  const unreadCount = notifications.filter((item) => !item.read).length;

  const loadProfile = useCallback(async (userEmail) => {
    if (!userEmail) {
      setProfile(null);
      return null;
    }
    const { data, error } = await supabase
      .from("sales_profiles")
      .select("*")
      .eq("login_email", normalize(userEmail))
      .maybeSingle();
    if (error) throw error;
    if (!data || data.role !== "staff") {
      await supabase.auth.signOut();
      throw new Error("Only team member accounts can use this Staff app.");
    }
    setProfile(data);
    return data;
  }, []);

  const loadSalesState = useCallback(async () => {
    const { data, error } = await supabase
      .from("sales_state")
      .select("data")
      .eq("id", "main")
      .maybeSingle();
    if (error) throw error;
    const nextState = data?.data || emptySalesState;
    nextState.orders ||= [];
    nextState.parties ||= [];
    nextState.misc ||= [];
    nextState.agents ||= [];
    nextState.staffs ||= [];
    setSalesState(nextState);
    return nextState;
  }, []);

  const saveSalesState = useCallback(async (nextState) => {
    const { error } = await supabase
      .from("sales_state")
      .upsert({ id: "main", data: nextState, updated_at: new Date().toISOString() }, { onConflict: "id" });
    if (error) throw error;
    setSalesState(nextState);
  }, []);

  const addInAppNotification = useCallback(async (title, body, orderId = "") => {
    const item = {
      id: Date.now().toString(),
      title,
      body,
      orderId,
      read: false,
      createdAt: new Date().toISOString()
    };
    setNotifications((current) => [item, ...current].slice(0, 50));
    await Notifications.scheduleNotificationAsync({
      content: { title, body, data: { orderId } },
      trigger: null
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      await loadSalesState();
    } catch (error) {
      Alert.alert("Cloud Load Failed", error.message || "Could not load assigned orders.");
    } finally {
      setLoading(false);
    }
  }, [loadSalesState]);

  useEffect(() => {
    let mounted = true;
    async function boot() {
      try {
        await Notifications.requestPermissionsAsync();
        const { data } = await supabase.auth.getSession();
        if (!mounted) return;
        setSession(data.session || null);
        if (data.session?.user?.email) {
          await loadProfile(data.session.user.email);
          await loadSalesState();
        }
      } catch (error) {
        Alert.alert("Login Check Failed", error.message || "Please login again.");
      } finally {
        if (mounted) setLoading(false);
      }
    }
    boot();
    const { data: authListener } = supabase.auth.onAuthStateChange(async (_event, nextSession) => {
      setSession(nextSession);
      if (nextSession?.user?.email) {
        try {
          await loadProfile(nextSession.user.email);
          await loadSalesState();
        } catch (error) {
          Alert.alert("Access Blocked", error.message);
        }
      } else {
        setProfile(null);
        setSalesState(emptySalesState);
      }
    });
    return () => {
      mounted = false;
      authListener.subscription.unsubscribe();
    };
  }, [loadProfile, loadSalesState]);

  useEffect(() => {
    if (!session) return undefined;
    const channel = supabase
      .channel("mtm-staff-sales-state")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sales_state", filter: "id=eq.main" },
        async () => {
          try {
            const nextState = await loadSalesState();
            const currentAssigned = (nextState.orders || []).filter((order) => normalize(order.assignedStaff) === staffEmail);
            const previous = previousAssignedIds.current;
            currentAssigned.forEach((order) => {
              const id = String(order.id);
              if (!previous.has(id)) {
                addInAppNotification(
                  "New Order Assigned",
                  `${order.mtmOrderNo || "Order"} - ${order.partyName || "Party"}`,
                  id
                );
              }
            });
            previousAssignedIds.current = new Set(currentAssigned.map((order) => String(order.id)));
          } catch (error) {
            Alert.alert("Realtime Sync Failed", error.message || "Could not sync latest orders.");
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [addInAppNotification, loadSalesState, session, staffEmail]);

  useEffect(() => {
    previousAssignedIds.current = new Set(assignedOrders.map((order) => String(order.id)));
  }, [assignedOrders]);

  async function handleLogin() {
    if (!email.trim() || !password) {
      Alert.alert("Missing Login", "Enter team member email and password.");
      return;
    }
    try {
      setLoginLoading(true);
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password
      });
      if (error) throw error;
      await loadProfile(data.user.email);
      await loadSalesState();
    } catch (error) {
      Alert.alert("Login Failed", error.message || "Could not login.");
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setSelectedOrderId(null);
    setPackingQty({});
    setQuery("");
  }

  async function updateOrderStatus(orderId, status) {
    const nextState = {
      ...salesState,
      orders: (salesState.orders || []).map((order) =>
        String(order.id) === String(orderId)
          ? { ...order, status, updatedAt: new Date().toISOString() }
          : order
      )
    };
    await saveSalesState(nextState);
  }

  async function createBale() {
    if (!selectedOrder) return;
    const packed = Object.entries(packingQty)
      .map(([colorNo, qty]) => ({ colorNo, qty: Number(qty || 0) }))
      .filter((row) => row.qty > 0);
    if (!packed.length) {
      Alert.alert("No QTY", "Enter at least one color QTY before creating bale.");
      return;
    }
    const nextBale = {
      baleNo: (selectedOrder.bales || []).length + 1,
      totalQty: selectedTotal,
      colors: packed,
      createdAt: new Date().toISOString(),
      staff: profile?.full_name || profile?.username || session?.user?.email
    };
    const total = getOrderTotal(selectedOrder);
    const sentAfter = getBaleSent(selectedOrder) + selectedTotal;
    const nextStatus = sentAfter >= total ? "Packed" : "In Packing";
    const nextState = {
      ...salesState,
      orders: (salesState.orders || []).map((order) =>
        String(order.id) === String(selectedOrder.id)
          ? {
              ...order,
              status: nextStatus,
              bales: [...(order.bales || []), nextBale],
              updatedAt: new Date().toISOString()
            }
          : order
      )
    };
    try {
      await saveSalesState(nextState);
      setPackingQty({});
      Alert.alert("Bale Created", `Bale ${nextBale.baleNo} saved successfully.`);
    } catch (error) {
      Alert.alert("Bale Save Failed", error.message || "Could not save bale.");
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color="#1d4ed8" />
        <Text style={styles.loadingText}>Loading MTM Staff...</Text>
      </SafeAreaView>
    );
  }

  if (!session) {
    return (
      <SafeAreaView style={styles.loginScreen}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.loginCard}>
          <Text style={styles.loginTitle}>MTM Staff</Text>
          <Text style={styles.loginSub}>Login once. Your session stays active until logout.</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="Team member email"
            style={styles.input}
          />
          <TextInput
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="Password"
            style={styles.input}
          />
          <AppButton title={loginLoading ? "Logging in..." : "Login"} onPress={handleLogin} disabled={loginLoading} />
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Team Member Portal</Text>
          <Text style={styles.subTitle}>{profile?.full_name || profile?.username || session.user.email}</Text>
        </View>
        <Pressable style={styles.bell} onPress={() => setNotifications((items) => items.map((item) => ({ ...item, read: true })))}>
          <Text style={styles.bellText}>Bell</Text>
          {unreadCount > 0 && <Text style={styles.badge}>{unreadCount}</Text>}
        </Pressable>
      </View>

      <View style={styles.statsRow}>
        <View style={styles.statCard}><Text style={styles.statNo}>{assignedOrders.length}</Text><Text>Assigned</Text></View>
        <View style={styles.statCard}><Text style={styles.statNo}>{assignedOrders.filter((o) => o.status === "In Packing").length}</Text><Text>In Process</Text></View>
        <View style={styles.statCard}><Text style={styles.statNo}>{assignedOrders.filter((o) => o.status === "Packed").length}</Text><Text>Completed</Text></View>
      </View>

      <View style={styles.toolbar}>
        <TextInput value={query} onChangeText={setQuery} placeholder="Search order, party, agent, quality..." style={styles.search} />
        <AppButton title="Refresh" onPress={refresh} tone="ghost" />
      </View>

      <FlatList
        data={filteredOrders}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={styles.empty}>No assigned orders found.</Text>}
        renderItem={({ item }) => {
          const total = getOrderTotal(item);
          const sent = getBaleSent(item);
          return (
            <Pressable onPress={() => setSelectedOrderId(String(item.id))} style={[styles.orderCard, String(item.id) === String(selectedOrderId) && styles.orderActive]}>
              <View style={styles.orderTop}>
                <Text style={styles.orderNo}>{item.mtmOrderNo || "Order"}</Text>
                <Text style={styles.status}>{item.status || "Assigned"}</Text>
              </View>
              <Text style={styles.party}>{item.partyName || "-"}</Text>
              <Text style={styles.meta}>Quality: {item.quality || "-"} | Cut: {item.cut || "-"}</Text>
              <Text style={styles.meta}>Packing: {item.packing || "-"} | Patta: {item.patta || "-"}</Text>
              <Text style={styles.meta}>Transport: {item.transport || "-"} | Station: {item.address || "-"}</Text>
              <Text style={styles.metaStrong}>Total / Sent / Pending: {total} / {sent} / {total - sent}</Text>
              <View style={styles.rowActions}>
                <AppButton title="Accept" onPress={() => updateOrderStatus(item.id, "Accepted")} tone="ghost" />
                <AppButton title="In Process" onPress={() => updateOrderStatus(item.id, "In Packing")} tone="ghost" />
                <AppButton title="Open Work" onPress={() => setSelectedOrderId(String(item.id))} />
              </View>
            </Pressable>
          );
        }}
      />

      {selectedOrder && (
        <View style={styles.workSheet}>
          <ScrollView>
            <Text style={styles.sheetTitle}>Bale Creation</Text>
            <Text style={styles.sheetSub}>{selectedOrder.mtmOrderNo} - {selectedOrder.partyName}</Text>
            <Text style={styles.metaStrong}>QTY Per Bale: {selectedOrder.qtyPerBale || "-"}</Text>
            <Text style={styles.selectedTotal}>Selected Total: {selectedTotal}</Text>
            {getPendingRows(selectedOrder).map((row) => (
              <View key={row.colorNo} style={styles.colorRow}>
                <View>
                  <Text style={styles.colorNo}>{row.colorNo}</Text>
                  <Text style={styles.meta}>Ordered: {row.ordered} | Pending: {row.pending}</Text>
                </View>
                <TextInput
                  value={packingQty[row.colorNo] || ""}
                  onChangeText={(value) => setPackingQty((current) => ({ ...current, [row.colorNo]: value.replace(/[^0-9.]/g, "") }))}
                  keyboardType="numeric"
                  placeholder="QTY"
                  style={styles.qtyInput}
                />
                <AppButton
                  title="Full"
                  tone="ghost"
                  onPress={() => setPackingQty((current) => ({ ...current, [row.colorNo]: String(row.pending) }))}
                />
              </View>
            ))}
            {(selectedOrder.bales || []).length > 0 && (
              <View style={styles.baleHistory}>
                <Text style={styles.sheetTitle}>Bales</Text>
                {(selectedOrder.bales || []).map((bale) => (
                  <Text key={bale.baleNo} style={styles.meta}>
                    Bale {bale.baleNo}: {bale.totalQty} pcs on {displayDate(bale.createdAt)}
                  </Text>
                ))}
              </View>
            )}
          </ScrollView>
          <View style={styles.fixedActions}>
            <AppButton title="Clear QTY" onPress={() => setPackingQty({})} tone="ghost" />
            <AppButton title="Create Bale" onPress={createBale} />
            <AppButton title="Close" onPress={() => setSelectedOrderId(null)} tone="danger" />
          </View>
        </View>
      )}

      <View style={styles.footerActions}>
        <AppButton title="Logout" onPress={handleLogout} tone="danger" />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#eef4fb" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#eef4fb" },
  loadingText: { marginTop: 12, color: "#475569", fontWeight: "700" },
  loginScreen: { flex: 1, backgroundColor: "#eaf6ff", alignItems: "center", justifyContent: "center", padding: 20 },
  loginCard: { width: "100%", borderRadius: 24, backgroundColor: "#fff", padding: 22, shadowColor: "#0f172a", shadowOpacity: 0.15, shadowRadius: 25, elevation: 6 },
  loginTitle: { fontSize: 30, fontWeight: "900", color: "#0f172a" },
  loginSub: { marginTop: 6, marginBottom: 18, color: "#64748b", fontWeight: "600" },
  input: { borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 14, padding: 14, marginBottom: 12, backgroundColor: "#fff", fontSize: 16 },
  header: { padding: 16, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontSize: 28, fontWeight: "900", color: "#0f172a" },
  subTitle: { color: "#64748b", fontWeight: "700", marginTop: 4 },
  bell: { minWidth: 54, minHeight: 54, borderRadius: 18, backgroundColor: "#0f172a", alignItems: "center", justifyContent: "center" },
  bellText: { color: "#fff", fontWeight: "900" },
  badge: { position: "absolute", top: -6, right: -6, backgroundColor: "#ef4444", color: "#fff", borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2, fontWeight: "900" },
  statsRow: { flexDirection: "row", gap: 10, paddingHorizontal: 16 },
  statCard: { flex: 1, backgroundColor: "#fff", borderRadius: 18, padding: 14, borderWidth: 1, borderColor: "#dbeafe" },
  statNo: { color: "#1d4ed8", fontWeight: "900", fontSize: 28 },
  toolbar: { padding: 16, gap: 10 },
  search: { borderWidth: 1, borderColor: "#bfdbfe", backgroundColor: "#fff", borderRadius: 16, padding: 13, fontSize: 16 },
  list: { padding: 16, paddingBottom: 110 },
  empty: { textAlign: "center", color: "#64748b", padding: 25, fontWeight: "700" },
  orderCard: { backgroundColor: "#fff", borderRadius: 20, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: "#dbeafe" },
  orderActive: { borderColor: "#2563eb", borderWidth: 2 },
  orderTop: { flexDirection: "row", justifyContent: "space-between", gap: 10 },
  orderNo: { fontSize: 22, fontWeight: "900", color: "#0f172a" },
  status: { color: "#92400e", backgroundColor: "#fef3c7", overflow: "hidden", paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, fontWeight: "900" },
  party: { fontSize: 18, color: "#0f172a", fontWeight: "900", marginTop: 8 },
  meta: { color: "#475569", fontWeight: "600", marginTop: 5 },
  metaStrong: { color: "#0f172a", fontWeight: "900", marginTop: 8 },
  rowActions: { flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 12 },
  button: { backgroundColor: "#16a34a", borderRadius: 16, paddingVertical: 13, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  buttonDanger: { backgroundColor: "#dc2626" },
  buttonGhost: { backgroundColor: "#e0edff" },
  buttonDisabled: { opacity: 0.55 },
  buttonPressed: { transform: [{ scale: 0.98 }] },
  buttonText: { color: "#fff", fontWeight: "900", fontSize: 15 },
  buttonGhostText: { color: "#1d4ed8" },
  workSheet: { ...StyleSheet.absoluteFillObject, backgroundColor: "#eef4fb", paddingTop: 12 },
  sheetTitle: { fontSize: 24, fontWeight: "900", color: "#0f172a", paddingHorizontal: 16 },
  sheetSub: { color: "#475569", fontWeight: "800", paddingHorizontal: 16, marginTop: 4, marginBottom: 8 },
  selectedTotal: { color: "#1d4ed8", fontWeight: "900", fontSize: 24, paddingHorizontal: 16, marginVertical: 8 },
  colorRow: { marginHorizontal: 16, marginBottom: 10, backgroundColor: "#fff", borderRadius: 18, borderWidth: 1, borderColor: "#bfdbfe", padding: 14, gap: 10 },
  colorNo: { color: "#1d4ed8", fontSize: 34, fontWeight: "900" },
  qtyInput: { borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 14, padding: 12, fontSize: 20, fontWeight: "900", backgroundColor: "#fff" },
  baleHistory: { padding: 16, paddingBottom: 140 },
  fixedActions: { position: "absolute", left: 12, right: 12, bottom: 12, backgroundColor: "#fff", borderRadius: 22, padding: 12, gap: 8, shadowColor: "#0f172a", shadowOpacity: 0.18, shadowRadius: 18, elevation: 10 },
  footerActions: { position: "absolute", left: 16, right: 16, bottom: 12 }
});
