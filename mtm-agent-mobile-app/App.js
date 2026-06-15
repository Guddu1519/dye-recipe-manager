import * as Clipboard from "expo-clipboard";
import * as ScreenCapture from "expo-screen-capture";
import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  StatusBar as NativeStatusBar,
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

function isBalePhotoExpired(bale) {
  const date = new Date(bale?.photoUploadedAt || bale?.createdAt || "");
  if (Number.isNaN(date.getTime())) return false;
  return Date.now() - date.getTime() > 31 * 24 * 60 * 60 * 1000;
}

function balePhotoMessage(bale) {
  return isBalePhotoExpired(bale)
    ? "This bale was created more than 1 month ago. No photo data available."
    : "No photo proof uploaded.";
}

function makeId() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function emptyOrderRequest() {
  return {
    partyName: "",
    partyOrderNo: "",
    orderDate: new Date().toISOString().slice(0, 10),
    quality: "",
    cut: "",
    qtyPerBale: "",
    packing: "",
    patta: "",
    stamping: "",
    transport: "",
    colors: [{ key: makeId(), colorNo: "", qty: "" }]
  };
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
  }).filter((row) => row.pending > 0);
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
  const [selectedBale, setSelectedBale] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestForm, setRequestForm] = useState(emptyOrderRequest);
  const [savingRequest, setSavingRequest] = useState(false);

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
    const agentRows = (salesState.agents || []).filter(
      (agent) => normalize(agent.email) === email || normalize(agent.name) === name
    );
    const ownsOrder = (order) => {
      if (normalize(order.agentEmail) === email || normalize(order.agentName) === name) return true;
      if (agentRows.some((agent) => normalize(agent.email) === normalize(order.agentEmail) || normalize(agent.name) === normalize(order.agentName))) return true;
      const party = (salesState.parties || []).find((p) => normalize(p.partyName) === normalize(order.partyName));
      if (!party) return false;
      if (normalize(party.agentEmail) === email || normalize(party.agentName) === name) return true;
      return agentRows.some((agent) => normalize(agent.email) === normalize(party.agentEmail) || normalize(agent.name) === normalize(party.agentName));
    };
    return (salesState.orders || []).filter((order) => {
      return ownsOrder(order);
    });
  }, [agentEmail, agentName, salesState.orders, salesState.parties, salesState.agents]);

  const assignedParties = useMemo(() => {
    const email = agentEmail;
    const name = agentName;
    const agentRows = (salesState.agents || []).filter(
      (agent) => normalize(agent.email) === email || normalize(agent.name) === name
    );
    return (salesState.parties || [])
      .filter((party) => {
        if (normalize(party.agentEmail) === email || normalize(party.agentName) === name) return true;
        return agentRows.some((agent) => normalize(agent.email) === normalize(party.agentEmail) || normalize(agent.name) === normalize(party.agentName));
      })
      .sort((a, b) => String(a.partyName || "").localeCompare(String(b.partyName || "")));
  }, [agentEmail, agentName, salesState.agents, salesState.parties]);

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
    setSelectedBale(null);
    await supabase.auth.signOut();
  }

  async function refresh() {
    try {
      setLoading(true);
      setQuery("");
      setSelectedOrder(null);
      setSelectedBale(null);
      await withTimeout(loadSalesState(), "Refresh is taking too long. Please check internet.");
    } catch (error) {
      Alert.alert("Refresh Failed", error.message || "Could not refresh orders.");
    } finally {
      setLoading(false);
    }
  }

  async function copyPendingReport(order) {
    const lines = getPendingRows(order)
      .map((row) => `${row.colorNo}: ${row.pending} pcs`);
    const text = lines.length ? lines.join("\n") : "No pending colors.";
    await Clipboard.setStringAsync(text);
    Alert.alert("Copied", "Pending color report copied.");
  }

  function updateRequestField(field, value) {
    setRequestForm((current) => ({ ...current, [field]: value }));
  }

  function updateRequestColor(key, field, value) {
    setRequestForm((current) => ({
      ...current,
      colors: current.colors.map((row) => row.key === key ? { ...row, [field]: value } : row)
    }));
  }

  function addRequestColor() {
    setRequestForm((current) => ({ ...current, colors: [...current.colors, { key: makeId(), colorNo: "", qty: "" }] }));
  }

  function removeRequestColor(key) {
    setRequestForm((current) => ({ ...current, colors: current.colors.length === 1 ? current.colors : current.colors.filter((row) => row.key !== key) }));
  }

  async function submitOrderRequest() {
    try {
      setSavingRequest(true);
      const party = assignedParties.find((item) => normalize(item.partyName) === normalize(requestForm.partyName));
      if (!party) throw new Error("Select one of your assigned parties.");
      const merged = {};
      requestForm.colors.forEach((row) => {
        const colorNo = cleanText(row.colorNo);
        const qty = Number(row.qty || 0);
        if (!colorNo && !qty) return;
        if (!colorNo) throw new Error("Color No. / Color Name is required.");
        if (!(qty > 0)) throw new Error(`QTY must be greater than 0 for ${colorNo}.`);
        const key = normalize(colorNo);
        if (!merged[key]) merged[key] = { colorNo, qty: 0 };
        merged[key].qty += qty;
      });
      const colors = Object.values(merged).map((row) => ({ ...row, pendingQty: row.qty }));
      if (!colors.length) throw new Error("Add at least one color.");
      const qtyPerBale = Number(requestForm.qtyPerBale || 0);
      if (!(qtyPerBale > 0)) throw new Error("QTY Per Bale is required.");
      const requiredFields = {
        Quality: requestForm.quality,
        Cut: requestForm.cut,
        Transport: requestForm.transport,
        Packing: requestForm.packing,
        Patta: requestForm.patta,
        Stamping: requestForm.stamping
      };
      const missing = Object.entries(requiredFields).filter(([, value]) => !cleanText(value)).map(([label]) => label);
      if (missing.length) throw new Error(`Required: ${missing.join(", ")}.`);
      const totalQty = colors.reduce((sum, row) => sum + row.qty, 0);
      const nextState = JSON.parse(JSON.stringify(salesState));
      nextState.orders ||= [];
      nextState.orders.push({
        id: makeId(),
        mtmOrderNo: `AGENT-${Date.now().toString().slice(-6)}`,
        partyOrderNo: cleanText(requestForm.partyOrderNo),
        orderDate: requestForm.orderDate || new Date().toISOString().slice(0, 10),
        partyName: party.partyName,
        gstNo: party.gstNo || "",
        agentName: party.agentName || profile?.full_name || profile?.username || "",
        agentEmail: party.agentEmail || profile?.login_email || session?.user?.email || "",
        partyAddress: party.address || party.city || "",
        transport: cleanText(requestForm.transport),
        packing: cleanText(requestForm.packing),
        patta: cleanText(requestForm.patta),
        stamping: cleanText(requestForm.stamping),
        quality: cleanText(requestForm.quality),
        cut: cleanText(requestForm.cut),
        qtyPerBale,
        totalQty,
        expectedBales: Math.max(1, Math.round(totalQty / qtyPerBale)),
        colors,
        assignedStaff: "",
        assignedStaffName: "",
        assignmentStatus: "Not Assigned Yet",
        status: "Not Assigned Yet",
        bales: [],
        createdBy: session?.user?.email || "",
        createdByAgent: true,
        createdAt: new Date().toISOString()
      });
      const { error } = await withTimeout(
        supabase.from("sales_state").upsert({ id: "main", data: nextState, updated_at: new Date().toISOString() }, { onConflict: "id" }),
        "Order request save is taking too long. Please check internet."
      );
      if (error) throw error;
      setSalesState(nextState);
      setRequestForm(emptyOrderRequest());
      setRequestOpen(false);
      Alert.alert("Order Sent", "Order sent to admin.");
    } catch (error) {
      Alert.alert("Order Request Failed", error.message || "Could not send order.");
    } finally {
      setSavingRequest(false);
    }
  }

  if (loading && !session) {
    return (
      <SafeAreaView style={[styles.loadingScreen, styles.safeTop]}>
        <ActivityIndicator size="large" color="#2563eb" />
        <Text style={styles.loadingText}>Loading MTM Agents...</Text>
      </SafeAreaView>
    );
  }

  if (!session || !profile) {
    return (
      <SafeAreaView style={[styles.loginScreen, styles.safeTop]}>
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
    <SafeAreaView style={[styles.screen, styles.safeTop]}>
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
            <AppButton title="Send New Order To Admin" onPress={() => setRequestOpen(true)} />
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
              <Text style={styles.meta}><Text style={styles.bold}>Total :</Text> {total} / <Text style={styles.bold}>Sent :</Text> {sent} / <Text style={styles.bold}>Pending :</Text> {pending}</Text>
              <Text style={[styles.status, completed ? styles.statusDone : styles.statusOpen]}>
                {completed ? "Completed" : item.status || "Pending"}
              </Text>
              <AppButton title="View Details" tone={completed ? "muted" : "primary"} onPress={() => setSelectedOrder(item)} />
            </Pressable>
          );
        }}
      />

      <Modal visible={!!selectedOrder} animationType="slide" onRequestClose={() => setSelectedOrder(null)}>
        <SafeAreaView style={[styles.modalScreen, styles.safeTop]}>
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
                {(selectedOrder.bales || []).map((bale) => (
                  <View key={bale.baleNo} style={styles.balePhotoCard}>
                    <Text style={styles.pendingColor}>Bale {bale.baleNo} - {bale.totalQty || 0} pcs</Text>
                    <Text style={styles.pendingValue}>Created: {displayDate(bale.createdAt)}</Text>
                    {bale.photoUrl && !isBalePhotoExpired(bale) ? (
                      <Image source={{ uri: bale.photoUrl }} style={styles.balePhoto} resizeMode="contain" />
                    ) : (
                      <Text style={styles.photoNote}>{balePhotoMessage(bale)}</Text>
                    )}
                    <AppButton title="View Details" onPress={() => setSelectedBale(bale)} />
                  </View>
                ))}

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
                <AppButton title="Close" tone="muted" onPress={() => { setSelectedBale(null); setSelectedOrder(null); }} />
              </>
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>

      <Modal visible={!!selectedBale && !!selectedOrder} animationType="slide" onRequestClose={() => setSelectedBale(null)}>
        <SafeAreaView style={[styles.modalScreen, styles.safeTop]}>
          <ScrollView contentContainerStyle={styles.modalContent}>
            {selectedOrder && selectedBale && (
              <>
                <Text style={styles.modalTitle}>Assortment Slip</Text>
                <View style={styles.slipCard}>
                  <View style={styles.slipHeader}>
                    <Text style={styles.slipTitle}>Bale {selectedBale.baleNo}</Text>
                    <Text style={styles.slipQty}>{selectedBale.totalQty || 0} pcs</Text>
                  </View>
                  <Text style={styles.meta}><Text style={styles.bold}>Party:</Text> {selectedOrder.partyName || "-"}</Text>
                  <Text style={styles.meta}><Text style={styles.bold}>Party Order No:</Text> {selectedOrder.partyOrderNo || "-"}</Text>
                  <Text style={styles.meta}><Text style={styles.bold}>MTM Order No:</Text> {selectedOrder.mtmOrderNo || "-"}</Text>
                  <Text style={styles.meta}><Text style={styles.bold}>Creation Time:</Text> {displayDate(selectedBale.createdAt)}</Text>
                  <Text style={styles.meta}><Text style={styles.bold}>Quality:</Text> {selectedOrder.quality || "-"} | <Text style={styles.bold}>Cut:</Text> {selectedOrder.cut || "-"}</Text>
                  <Text style={styles.meta}><Text style={styles.bold}>Station:</Text> {selectedOrder.partyAddress || "-"}</Text>
                  <Text style={styles.meta}><Text style={styles.bold}>Transport:</Text> {selectedOrder.transport || "-"}</Text>
                  <Text style={styles.meta}><Text style={styles.bold}>Packing:</Text> {selectedOrder.packing || "-"} | <Text style={styles.bold}>Patta:</Text> {selectedOrder.patta || "-"}</Text>
                  <Text style={styles.meta}><Text style={styles.bold}>Stamping:</Text> {selectedOrder.stamping || "-"}</Text>
                </View>
                <Text style={styles.subTitle}>Bale Colors</Text>
                <View style={styles.pendingTable}>
                  {(selectedBale.colors || []).map((row, index) => (
                    <View style={styles.pendingRow} key={`${row.colorNo}_${index}`}>
                      <Text style={styles.pendingColor}>{row.colorNo}</Text>
                      <Text style={styles.pendingValue}>Pieces: {row.qty || 0}</Text>
                    </View>
                  ))}
                </View>
                <Text style={styles.subTitle}>Photo Proof</Text>
                {selectedBale.photoUrl && !isBalePhotoExpired(selectedBale) ? (
                  <Image source={{ uri: selectedBale.photoUrl }} style={styles.balePhotoLarge} resizeMode="contain" />
                ) : (
                  <Text style={styles.photoNote}>{balePhotoMessage(selectedBale)}</Text>
                )}
                <AppButton title="Close" tone="muted" onPress={() => setSelectedBale(null)} />
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

      <Modal visible={requestOpen} animationType="slide" onRequestClose={() => setRequestOpen(false)}>
        <SafeAreaView style={[styles.modalScreen, styles.safeTop]}>
          <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>Send Order To Admin</Text>
            <Text style={styles.loginSub}>Type party name exactly as assigned, then add colors and QTY.</Text>
            <TextInput value={requestForm.partyName} onChangeText={(value) => updateRequestField("partyName", value)} placeholder="Assigned Party Name" placeholderTextColor="#64748b" style={styles.input} />
            {!!assignedParties.length && (
              <View style={styles.partyChips}>
                {assignedParties.slice(0, 12).map((party) => (
                  <Pressable key={party.partyName} style={styles.partyChip} onPress={() => updateRequestField("partyName", party.partyName)}>
                    <Text style={styles.partyChipText}>{party.partyName}</Text>
                  </Pressable>
                ))}
              </View>
            )}
            <TextInput value={requestForm.partyOrderNo} onChangeText={(value) => updateRequestField("partyOrderNo", value)} placeholder="Party Order No." placeholderTextColor="#64748b" style={styles.input} />
            <TextInput value={requestForm.orderDate} onChangeText={(value) => updateRequestField("orderDate", value)} placeholder="Date YYYY-MM-DD" placeholderTextColor="#64748b" style={styles.input} />
            <TextInput value={requestForm.quality} onChangeText={(value) => updateRequestField("quality", value)} placeholder="Quality" placeholderTextColor="#64748b" style={styles.input} />
            <TextInput value={requestForm.cut} onChangeText={(value) => updateRequestField("cut", value)} placeholder="Cut" placeholderTextColor="#64748b" style={styles.input} />
            <TextInput value={requestForm.qtyPerBale} onChangeText={(value) => updateRequestField("qtyPerBale", value)} placeholder="QTY Per Bale" keyboardType="number-pad" placeholderTextColor="#64748b" style={styles.input} />
            <TextInput value={requestForm.packing} onChangeText={(value) => updateRequestField("packing", value)} placeholder="Packing" placeholderTextColor="#64748b" style={styles.input} />
            <TextInput value={requestForm.patta} onChangeText={(value) => updateRequestField("patta", value)} placeholder="Patta" placeholderTextColor="#64748b" style={styles.input} />
            <TextInput value={requestForm.stamping} onChangeText={(value) => updateRequestField("stamping", value)} placeholder="Stamping" placeholderTextColor="#64748b" style={styles.input} />
            <TextInput value={requestForm.transport} onChangeText={(value) => updateRequestField("transport", value)} placeholder="Transport" placeholderTextColor="#64748b" style={styles.input} />
            <Text style={styles.subTitle}>Colors</Text>
            {requestForm.colors.map((row) => (
              <View key={row.key} style={styles.requestColorRow}>
                <TextInput value={row.colorNo} onChangeText={(value) => updateRequestColor(row.key, "colorNo", value)} placeholder="Color No. / Name" placeholderTextColor="#64748b" style={[styles.input, styles.requestColorInput]} />
                <TextInput value={row.qty} onChangeText={(value) => updateRequestColor(row.key, "qty", value)} placeholder="QTY" keyboardType="number-pad" placeholderTextColor="#64748b" style={[styles.input, styles.requestQtyInput]} />
                <Pressable style={styles.removeButton} onPress={() => removeRequestColor(row.key)}><Text style={styles.removeText}>X</Text></Pressable>
              </View>
            ))}
            <AppButton title="Add Color" tone="muted" onPress={addRequestColor} />
            <AppButton title={savingRequest ? "Sending..." : "Send Order To Admin"} onPress={submitOrderRequest} disabled={savingRequest} />
            <AppButton title="Close" tone="muted" onPress={() => setRequestOpen(false)} />
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeTop: { paddingTop: Platform.OS === "android" ? NativeStatusBar.currentHeight || 0 : 0 },
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
  balePhotoCard: { backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: "#dbeafe", padding: 12, marginTop: 10 },
  balePhoto: { width: "100%", height: 220, borderRadius: 14, borderWidth: 1, borderColor: "#cbd5e1", backgroundColor: "#fff" },
  balePhotoLarge: { width: "100%", height: 320, borderRadius: 14, borderWidth: 1, borderColor: "#cbd5e1", backgroundColor: "#fff" },
  photoNote: { marginTop: 4, color: "#64748b", fontWeight: "800", backgroundColor: "#f8fafc", borderRadius: 12, padding: 10 },
  slipCard: { backgroundColor: "#fff", borderRadius: 16, borderWidth: 1, borderColor: "#cbd5e1", padding: 14, gap: 4 },
  slipHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: "#e2e8f0", paddingBottom: 10, marginBottom: 8 },
  slipTitle: { color: "#0f172a", fontSize: 22, fontWeight: "900" },
  slipQty: { color: "#166534", fontSize: 18, fontWeight: "900" },
  partyChips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  partyChip: { backgroundColor: "#dbeafe", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  partyChipText: { color: "#1e3a8a", fontWeight: "900", fontSize: 12 },
  requestColorRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  requestColorInput: { flex: 1 },
  requestQtyInput: { width: 96 },
  removeButton: { width: 42, height: 50, borderRadius: 13, backgroundColor: "#dc2626", alignItems: "center", justifyContent: "center", marginBottom: 12 },
  removeText: { color: "#fff", fontWeight: "900" },
  menuOverlay: { flex: 1, backgroundColor: "rgba(15,23,42,0.35)", justifyContent: "flex-start", alignItems: "flex-end", padding: 16, paddingTop: 58 },
  menuCard: { width: 230, backgroundColor: "#fff", borderRadius: 18, padding: 16, shadowColor: "#0f172a", shadowOpacity: 0.2, shadowRadius: 18, elevation: 8 },
  menuTitle: { fontSize: 20, fontWeight: "900", color: "#0f172a" },
  menuSub: { color: "#64748b", fontWeight: "700", marginTop: 4, marginBottom: 10 }
});
