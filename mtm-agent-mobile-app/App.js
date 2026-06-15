import * as Clipboard from "expo-clipboard";
import * as ScreenCapture from "expo-screen-capture";
import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
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

const emptySalesState = { parties: [], misc: [], orders: [], agents: [], staffs: [] };
const APP_VERSION = Constants.expoConfig?.version || "1.0.0";
const CLOUD_TIMEOUT_MS = 12000;

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanText(value) {
  return String(value || "").trim();
}

function withTimeout(promise, message = "Cloud request timed out. Please check internet and try again.") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), CLOUD_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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

function getPendingQty(order) {
  return getOrderTotal(order) - getBaleSent(order);
}

function expectedBales(order) {
  const baleSize = Number(order.qtyPerBale || 0);
  if (!baleSize) return 0;
  return Math.max(1, Math.round(getOrderTotal(order) / baleSize));
}

function isOrderLocked(order) {
  return !!(order?.adminPaidLocked || order?.manualPaidByAdmin);
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
    return { colorNo, ordered, sent, pending: ordered - sent };
  });
}

function baleSummary(order) {
  if (!(order.bales || []).length) return "No bales dispatched yet.";
  return (order.bales || [])
    .map((bale) => `Bale ${bale.baleNo}: ${bale.totalQty || 0} pcs on ${displayDate(bale.createdAt)}`)
    .join("\n");
}

function AppButton({ title, onPress, tone = "primary", disabled = false }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        tone === "danger" && styles.buttonDanger,
        tone === "muted" && styles.buttonMuted,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed
      ]}
    >
      <Text style={styles.buttonText}>{title}</Text>
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
  const [query, setQuery] = useState("");
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const agentEmail = normalize(profile?.login_email || session?.user?.email);
  const agentName = normalize(profile?.full_name || profile?.username);

  const loadProfile = useCallback(async (userEmail) => {
    const { data, error } = await supabase
      .from("sales_profiles")
      .select("*")
      .eq("login_email", normalize(userEmail))
      .eq("active", true)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("Agent login not found or inactive.");
    if (normalize(data.role) !== "agent") throw new Error("Only agent login can use MTM - Agents.");
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
    nextState.parties ||= [];
    nextState.misc ||= [];
    nextState.orders ||= [];
    nextState.agents ||= [];
    nextState.staffs ||= [];
    setSalesState(nextState);
    return nextState;
  }, []);

  useEffect(() => {
    ScreenCapture.preventScreenCaptureAsync().catch(() => {});
    let mounted = true;
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!mounted) return;
        setSession(data.session || null);
        if (data.session?.user?.email) {
          await withTimeout(loadProfile(data.session.user.email), "Profile load is taking too long. Please check internet.");
          await withTimeout(loadSalesState(), "Order load is taking too long. Please check internet.");
        }
      } catch (error) {
        Alert.alert("Login Check Failed", error.message || "Please login again.");
        await supabase.auth.signOut();
        setSession(null);
        setProfile(null);
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    const { data: authListener } = supabase.auth.onAuthStateChange(async (_event, nextSession) => {
      setSession(nextSession || null);
      if (nextSession?.user?.email) {
        try {
          setLoading(true);
          await withTimeout(loadProfile(nextSession.user.email), "Profile load is taking too long. Please check internet.");
          await withTimeout(loadSalesState(), "Order load is taking too long. Please check internet.");
        } catch (error) {
          Alert.alert("Login Failed", error.message || "Please login again.");
          await supabase.auth.signOut();
        } finally {
          setLoading(false);
        }
      } else {
        setProfile(null);
      }
    });

    return () => {
      mounted = false;
      authListener?.subscription?.unsubscribe?.();
      ScreenCapture.allowScreenCaptureAsync().catch(() => {});
    };
  }, [loadProfile, loadSalesState]);

  useEffect(() => {
    if (!session?.user || !profile) return undefined;
    const channel = supabase
      .channel("mtm-agent-sales-state")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sales_state", filter: "id=eq.main" },
        async () => {
          try {
            await loadSalesState();
          } catch (error) {
            Alert.alert("Sync Failed", error.message || "Could not sync latest orders.");
          }
        }
      )
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [loadSalesState, profile, session?.user]);

  const agentOrders = useMemo(() => {
    const email = agentEmail;
    const name = agentName;
    return (salesState.orders || []).filter((order) => {
      const directMatch = normalize(order.agentEmail) === email || normalize(order.agentName) === name;
      if (directMatch) return true;
      const party = (salesState.parties || []).find((p) => normalize(p.partyName) === normalize(order.partyName));
      return !!party && (normalize(party.agentEmail) === email || normalize(party.agentName) === name);
    });
  }, [agentEmail, agentName, salesState.orders, salesState.parties]);

  const filteredOrders = useMemo(() => {
    const q = normalize(query);
    if (!q) return agentOrders;
    return agentOrders.filter((order) => [
      order.mtmOrderNo,
      order.partyOrderNo,
      order.partyName,
      order.agentName,
      order.quality,
      order.cut,
      order.packing,
      order.patta,
      order.stamping,
      order.transport,
      order.partyAddress,
      order.status
    ].some((value) => normalize(value).includes(q)));
  }, [agentOrders, query]);

  const stats = useMemo(() => {
    const totalQty = agentOrders.reduce((sum, order) => sum + getOrderTotal(order), 0);
    const sentQty = agentOrders.reduce((sum, order) => sum + getBaleSent(order), 0);
    const pendingQty = totalQty - sentQty;
    const completed = agentOrders.filter((order) => getPendingQty(order) <= 0 || isOrderLocked(order) || order.status === "Packed").length;
    return { totalOrders: agentOrders.length, totalQty, sentQty, pendingQty, completed };
  }, [agentOrders]);

  async function handleLogin() {
    if (!email.trim() || !password) {
      Alert.alert("Missing Login", "Enter agent email and password.");
      return;
    }
    try {
      setLoginLoading(true);
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password
      });
      if (error) throw error;
      await withTimeout(loadProfile(data.user.email), "Profile load is taking too long. Please check internet.");
      await withTimeout(loadSalesState(), "Order load is taking too long. Please check internet.");
    } catch (error) {
      Alert.alert("Login Failed", error.message || "Could not login.");
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleLogout() {
    setMenuOpen(false);
    setQuery("");
    setSelectedOrder(null);
    await supabase.auth.signOut();
  }

  async function refresh() {
    try {
      setLoading(true);
      setQuery("");
      setSelectedOrder(null);
      await withTimeout(loadSalesState(), "Refresh is taking too long. Please check internet.");
    } catch (error) {
      Alert.alert("Refresh Failed", error.message || "Could not refresh orders.");
    } finally {
      setLoading(false);
    }
  }

  async function copyPendingReport(order) {
    const lines = getPendingRows(order)
      .filter((row) => row.pending !== 0)
      .map((row) => `${row.colorNo}: ${row.pending} pcs`);
    const text = lines.length ? lines.join("\n") : "No pending colors.";
    await Clipboard.setStringAsync(text);
    Alert.alert("Copied", "Pending color report copied.");
  }

  if (loading && !session) {
    return (
      <SafeAreaView style={styles.loadingScreen}>
        <ActivityIndicator size="large" color="#2563eb" />
        <Text style={styles.loadingText}>Loading MTM Agents...</Text>
      </SafeAreaView>
    );
  }

  if (!session || !profile) {
    return (
      <SafeAreaView style={styles.loginScreen}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.loginCard}>
          <Text style={styles.loginTitle}>MTM Agents</Text>
          <Text style={styles.loginSub}>Agent order status portal. Login once and stay signed in.</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="Agent email"
            placeholderTextColor="#64748b"
            style={styles.input}
          />
          <TextInput
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="Password"
            placeholderTextColor="#64748b"
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
          <Text style={styles.title}>Agent Portal</Text>
          <Text style={styles.agentName}>{cleanText(profile.full_name || profile.username || profile.login_email)}</Text>
        </View>
        <Pressable style={styles.menuButton} onPress={() => setMenuOpen(true)}>
          <Text style={styles.menuDots}>...</Text>
        </Pressable>
      </View>

      <FlatList
        data={filteredOrders}
        keyExtractor={(item) => String(item.id || item.mtmOrderNo || item.partyOrderNo)}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View>
            <View style={styles.statsGrid}>
              <View style={styles.statCard}><Text style={styles.statNo}>{stats.totalOrders}</Text><Text style={styles.statLabel}>Orders</Text></View>
              <View style={styles.statCard}><Text style={styles.statNo}>{stats.pendingQty}</Text><Text style={styles.statLabel}>Pending PCS</Text></View>
              <View style={styles.statCard}><Text style={styles.statNo}>{stats.sentQty}</Text><Text style={styles.statLabel}>Sent PCS</Text></View>
              <View style={styles.statCard}><Text style={styles.statNo}>{stats.completed}</Text><Text style={styles.statLabel}>Completed</Text></View>
            </View>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search order, party, quality, transport..."
              placeholderTextColor="#64748b"
              style={styles.search}
            />
            <AppButton title="Refresh" onPress={refresh} tone="muted" disabled={loading} />
            <Text style={styles.sectionTitle}>Agent Orders</Text>
          </View>
        }
        ListEmptyComponent={<Text style={styles.empty}>No orders found for this agent.</Text>}
        renderItem={({ item }) => {
          const sent = getBaleSent(item);
          const total = getOrderTotal(item);
          const pending = total - sent;
          const completed = pending <= 0 || isOrderLocked(item) || item.status === "Packed";
          return (
            <Pressable style={[styles.orderCard, completed && styles.completedOrderCard]} onPress={() => setSelectedOrder(item)}>
              <Text style={styles.orderNo}>{item.mtmOrderNo || "Order"} - {item.partyName || "-"}</Text>
              <Text style={styles.meta}><Text style={styles.bold}>Party Order:</Text> {item.partyOrderNo || "-"}</Text>
              <Text style={styles.meta}><Text style={styles.bold}>Quality:</Text> <Text style={styles.badgeText}>{item.quality || "-"}</Text> | <Text style={styles.bold}>Cut:</Text> {item.cut || "-"}</Text>
              <Text style={styles.meta}><Text style={styles.bold}>Packing:</Text> {item.packing || "-"} | <Text style={styles.bold}>Patta:</Text> {item.patta || "-"}</Text>
              <Text style={styles.meta}><Text style={styles.bold}>Stamping:</Text> {item.stamping || "-"} | <Text style={styles.bold}>Transport:</Text> {item.transport || "-"}</Text>
              <Text style={styles.meta}><Text style={styles.bold}>Total / Sent / Pending:</Text> {total} / {sent} / {pending}</Text>
              <Text style={[styles.status, completed ? styles.statusDone : styles.statusOpen]}>
                {completed ? "Completed" : item.status || "Pending"}
              </Text>
              <AppButton title="View Details" tone={completed ? "muted" : "primary"} onPress={() => setSelectedOrder(item)} />
            </Pressable>
          );
        }}
      />

      <Modal visible={!!selectedOrder} animationType="slide" onRequestClose={() => setSelectedOrder(null)}>
        <SafeAreaView style={styles.modalScreen}>
          <ScrollView contentContainerStyle={styles.modalContent}>
            {selectedOrder && (
              <>
                <Text style={styles.modalTitle}>{selectedOrder.mtmOrderNo} - {selectedOrder.partyName}</Text>
                <Text style={styles.meta}><Text style={styles.bold}>Party Order:</Text> {selectedOrder.partyOrderNo || "-"}</Text>
                <Text style={styles.meta}><Text style={styles.bold}>Quality:</Text> {selectedOrder.quality || "-"} | <Text style={styles.bold}>Cut:</Text> {selectedOrder.cut || "-"}</Text>
                <Text style={styles.meta}><Text style={styles.bold}>Station:</Text> {selectedOrder.partyAddress || "-"}</Text>
                <Text style={styles.meta}><Text style={styles.bold}>Transport:</Text> {selectedOrder.transport || "-"}</Text>
                <Text style={styles.meta}><Text style={styles.bold}>Packing:</Text> {selectedOrder.packing || "-"} | <Text style={styles.bold}>Patta:</Text> {selectedOrder.patta || "-"}</Text>
                <Text style={styles.meta}><Text style={styles.bold}>Stamping:</Text> {selectedOrder.stamping || "-"}</Text>
                <View style={styles.detailGrid}>
                  <Text style={styles.detailItem}>Total QTY: {getOrderTotal(selectedOrder)}</Text>
                  <Text style={styles.detailItem}>Pending PCS: {getPendingQty(selectedOrder)}</Text>
                  <Text style={styles.detailItem}>Bale Size: {selectedOrder.qtyPerBale || "-"}</Text>
                  <Text style={styles.detailItem}>Expected Bales: {expectedBales(selectedOrder)}</Text>
                  <Text style={styles.detailItem}>Created Bales: {(selectedOrder.bales || []).length}</Text>
                </View>
                <Text style={styles.subTitle}>Bale Dispatch</Text>
                <Text style={styles.dispatchBox}>{baleSummary(selectedOrder)}</Text>

                <Text style={styles.subTitle}>Pending Colors</Text>
                <View style={styles.pendingTable}>
                  {getPendingRows(selectedOrder).map((row) => (
                    <View style={styles.pendingRow} key={row.colorNo}>
                      <Text style={styles.pendingColor}>Color {row.colorNo}</Text>
                      <Text style={styles.pendingValue}>Ordered {row.ordered}</Text>
                      <Text style={styles.pendingValue}>Sent {row.sent}</Text>
                      <Text style={styles.pendingValue}>Pending {row.pending}</Text>
                    </View>
                  ))}
                </View>
                <AppButton title="Copy Pending Report" onPress={() => copyPendingReport(selectedOrder)} />
                <AppButton title="Close" tone="muted" onPress={() => setSelectedOrder(null)} />
              </>
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <Modal transparent visible={menuOpen} animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.menuOverlay} onPress={() => setMenuOpen(false)}>
          <View style={styles.menuCard}>
            <Text style={styles.menuTitle}>MTM - Agents</Text>
            <Text style={styles.menuSub}>Version {APP_VERSION}</Text>
            <AppButton title="Logout" tone="danger" onPress={handleLogout} />
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  loadingScreen: { flex: 1, backgroundColor: "#eaf6ff", alignItems: "center", justifyContent: "center" },
  loadingText: { marginTop: 12, fontSize: 17, color: "#475569", fontWeight: "800" },
  loginScreen: { flex: 1, backgroundColor: "#eaf6ff", alignItems: "center", justifyContent: "center", padding: 20 },
  loginCard: { width: "100%", borderRadius: 24, backgroundColor: "#fff", padding: 22, shadowColor: "#0f172a", shadowOpacity: 0.15, shadowRadius: 25, elevation: 6 },
  loginTitle: { fontSize: 30, fontWeight: "900", color: "#0f172a" },
  loginSub: { marginTop: 6, marginBottom: 18, color: "#64748b", fontWeight: "600" },
  input: { borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 14, padding: 14, marginBottom: 12, fontSize: 16, color: "#0f172a", backgroundColor: "#fff" },
  screen: { flex: 1, backgroundColor: "#eef6ff" },
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontSize: 30, fontWeight: "900", color: "#0f172a" },
  agentName: { marginTop: 2, color: "#475569", fontWeight: "900", fontSize: 15, textTransform: "uppercase" },
  menuButton: { backgroundColor: "#0f172a", borderRadius: 16, width: 58, height: 58, alignItems: "center", justifyContent: "center" },
  menuDots: { color: "#fff", fontSize: 26, fontWeight: "900", marginTop: -8 },
  listContent: { padding: 14, paddingBottom: 34 },
  statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  statCard: { flexGrow: 1, flexBasis: "45%", backgroundColor: "#fff", borderRadius: 18, padding: 16, borderWidth: 1, borderColor: "#dbeafe" },
  statNo: { color: "#1d4ed8", fontSize: 30, fontWeight: "900" },
  statLabel: { color: "#0f172a", fontWeight: "800", marginTop: 4 },
  search: { backgroundColor: "#fff", borderRadius: 16, borderWidth: 1, borderColor: "#cbd5e1", padding: 15, marginTop: 14, marginBottom: 10, fontSize: 16, color: "#0f172a" },
  sectionTitle: { marginTop: 18, marginBottom: 8, fontSize: 24, fontWeight: "900", color: "#0f172a" },
  empty: { color: "#64748b", fontSize: 16, padding: 16, textAlign: "center" },
  orderCard: { backgroundColor: "#fff", borderRadius: 18, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: "#dbeafe", shadowColor: "#0f172a", shadowOpacity: 0.06, shadowRadius: 12, elevation: 2 },
  completedOrderCard: { backgroundColor: "#f8fafc", borderColor: "#cbd5e1" },
  orderNo: { fontSize: 22, color: "#0f172a", fontWeight: "900", marginBottom: 10 },
  meta: { color: "#334155", fontSize: 15, marginBottom: 6, lineHeight: 22 },
  bold: { fontWeight: "900", color: "#0f172a" },
  badgeText: { color: "#92400e", fontWeight: "900" },
  status: { alignSelf: "flex-start", borderRadius: 999, paddingHorizontal: 13, paddingVertical: 7, fontWeight: "900", marginVertical: 8 },
  statusDone: { backgroundColor: "#dcfce7", color: "#166534" },
  statusOpen: { backgroundColor: "#fef3c7", color: "#92400e" },
  locked: { backgroundColor: "#fee2e2", color: "#991b1b", borderRadius: 12, padding: 10, fontWeight: "900", marginVertical: 8 },
  button: { backgroundColor: "#2563eb", borderRadius: 14, padding: 15, alignItems: "center", justifyContent: "center", marginTop: 10 },
  buttonDanger: { backgroundColor: "#dc2626" },
  buttonMuted: { backgroundColor: "#64748b" },
  buttonDisabled: { opacity: 0.55 },
  buttonPressed: { transform: [{ scale: 0.99 }], opacity: 0.85 },
  buttonText: { color: "#fff", fontWeight: "900", fontSize: 16 },
  modalScreen: { flex: 1, backgroundColor: "#eef6ff" },
  modalContent: { padding: 16, paddingBottom: 38 },
  modalTitle: { fontSize: 26, color: "#0f172a", fontWeight: "900", marginBottom: 12 },
  detailGrid: { backgroundColor: "#fff", borderRadius: 16, padding: 14, marginVertical: 12, borderWidth: 1, borderColor: "#dbeafe" },
  detailItem: { color: "#0f172a", fontWeight: "800", fontSize: 16, marginBottom: 7 },
  subTitle: { marginTop: 16, marginBottom: 8, fontSize: 21, color: "#0f172a", fontWeight: "900" },
  dispatchBox: { backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: "#dbeafe", padding: 14, color: "#334155", fontWeight: "700", lineHeight: 24 },
  pendingTable: { gap: 8 },
  pendingRow: { backgroundColor: "#fff", borderRadius: 14, padding: 12, borderWidth: 1, borderColor: "#dbeafe" },
  pendingColor: { color: "#1d4ed8", fontWeight: "900", fontSize: 19, marginBottom: 6 },
  pendingValue: { color: "#334155", fontWeight: "800", marginBottom: 3 },
  menuOverlay: { flex: 1, backgroundColor: "rgba(15,23,42,0.35)", justifyContent: "flex-start", alignItems: "flex-end", padding: 16, paddingTop: 58 },
  menuCard: { width: 230, backgroundColor: "#fff", borderRadius: 18, padding: 16, shadowColor: "#0f172a", shadowOpacity: 0.2, shadowRadius: 18, elevation: 8 },
  menuTitle: { fontSize: 20, fontWeight: "900", color: "#0f172a" },
  menuSub: { color: "#64748b", fontWeight: "700", marginTop: 4, marginBottom: 10 }
});
