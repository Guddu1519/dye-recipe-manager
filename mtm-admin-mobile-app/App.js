import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Print from "expo-print";
import * as ScreenCapture from "expo-screen-capture";
import * as Sharing from "expo-sharing";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
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

const EMPTY_STATE = { parties: [], misc: [], orders: [], agents: [], staffs: [] };
const APP_VERSION = Constants.expoConfig?.version || "1.0.0";
const CLOUD_TIMEOUT_MS = 15000;
const CUT_OPTIONS = ["THAN", "1 MTR", "2 MTR", "80 CM", "75 CM", "78 CM", "77 CM", "LUMP", "FULL LUMP", "L95 THAN"];
const NAV_ITEMS = [
  ["dashboard", "Dashboard"],
  ["orders", "Orders"],
  ["dispatch", "Daily Dispatch"],
  ["pending", "Pending Summary"],
  ["team", "Team Reports"],
  ["parties", "Party Master"],
  ["agents", "Agent Ledger"],
  ["members", "Team Members"],
  ["misc", "Misc Master"],
  ["backup", "Data Backup"]
];

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function clean(value) {
  return String(value || "").trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function withTimeout(promise, message = "Cloud request timed out. Check internet and try again.") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), CLOUD_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function displayDate(value, withTime = false) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("en-IN", withTime
    ? { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }
    : { day: "2-digit", month: "2-digit", year: "numeric" });
}

function isoDate(date = new Date()) {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 10);
}

function getOrderTotal(order) {
  return (order?.colors || []).reduce((sum, row) => sum + Number(row.qty || 0), 0);
}

function getBaleRows(bale) {
  return bale?.colors || bale?.items || [];
}

function getSentQty(order) {
  return (order?.bales || []).reduce((sum, bale) => sum + Number(bale.totalQty || 0), 0);
}

function getPendingQty(order) {
  return (order?.colors || []).reduce((sum, row) => {
    if (row.pendingQty !== undefined) return sum + Number(row.pendingQty || 0);
    const sent = (order.bales || []).reduce((baleSum, bale) => baleSum + getBaleRows(bale)
      .filter((item) => normalize(item.colorNo) === normalize(row.colorNo))
      .reduce((itemSum, item) => itemSum + Number(item.qty || 0), 0), 0);
    return sum + Number(row.qty || 0) - sent;
  }, 0);
}

function expectedBales(total, size) {
  const qty = Number(total || 0);
  const baleSize = Number(size || 0);
  return qty > 0 && baleSize > 0 ? Math.max(1, Math.round(qty / baleSize)) : 0;
}

function isLocked(order) {
  return !!(order?.adminPaidLocked || order?.manualPaidByAdmin);
}

function orderStatus(order) {
  if (isLocked(order)) return "Completed";
  return order?.status || "Not Assigned Yet";
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function profileName(profile, session) {
  return clean(profile?.full_name || profile?.username || session?.user?.email?.split("@")[0] || "ADMIN").toUpperCase();
}

function orderSearchText(order) {
  return [
    order.mtmOrderNo, order.partyOrderNo, order.partyName, order.gstNo, order.agentName,
    order.quality, order.cut, order.packing, order.patta, order.stamping, order.transport,
    order.assignedStaffName, order.assignedStaff, orderStatus(order)
  ].join(" ").toLowerCase();
}

function AppButton({ title, onPress, tone = "primary", disabled = false, compact = false }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        tone === "danger" && styles.buttonDanger,
        tone === "muted" && styles.buttonMuted,
        tone === "success" && styles.buttonSuccess,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed
      ]}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

function Field({ label, value, onChangeText, placeholder, keyboardType = "default", secureTextEntry = false, multiline = false }) {
  return (
    <View style={styles.fieldWrap}>
      {!!label && <Text style={styles.label}>{label}</Text>}
      <TextInput
        value={String(value ?? "")}
        onChangeText={onChangeText}
        placeholder={placeholder || label}
        placeholderTextColor="#94a3b8"
        keyboardType={keyboardType}
        secureTextEntry={secureTextEntry}
        multiline={multiline}
        style={[styles.input, multiline && styles.inputMultiline]}
      />
    </View>
  );
}

function ChoiceField({ label, value, options, onSelect, placeholder = "Select" }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.fieldWrap}>
      {!!label && <Text style={styles.label}>{label}</Text>}
      <Pressable style={styles.input} onPress={() => setOpen(true)}>
        <Text style={value ? styles.choiceText : styles.placeholder}>{value || placeholder}</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.modalShade} onPress={() => setOpen(false)}>
          <View style={styles.choiceModal}>
            <Text style={styles.modalTitle}>{label || placeholder}</Text>
            <ScrollView style={{ maxHeight: 420 }}>
              {options.map((option) => {
                const item = typeof option === "string" ? { label: option, value: option } : option;
                return (
                  <Pressable
                    key={`${item.value}-${item.label}`}
                    style={styles.choiceRow}
                    onPress={() => {
                      onSelect(item.value, item);
                      setOpen(false);
                    }}
                  >
                    <Text style={styles.choiceRowText}>{item.label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <AppButton title="Cancel" tone="muted" onPress={() => setOpen(false)} />
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

function Section({ title, children, right }) {
  return (
    <View style={styles.card}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

function Stat({ label, value, tone = "blue" }) {
  return (
    <View style={[styles.statCard, tone === "green" && styles.statGreen, tone === "amber" && styles.statAmber]}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function StatusBadge({ status }) {
  const completed = ["completed", "packed"].includes(normalize(status));
  const danger = normalize(status) === "cancelled";
  return (
    <View style={[styles.badge, completed && styles.badgeGreen, danger && styles.badgeRed]}>
      <Text style={[styles.badgeText, completed && styles.badgeGreenText, danger && styles.badgeRedText]}>{status}</Text>
    </View>
  );
}

function emptyOrderForm() {
  return {
    id: "",
    mtmOrderNo: "",
    partyOrderNo: "",
    orderDate: isoDate(),
    partyName: "",
    gstNo: "",
    agentName: "",
    agentEmail: "",
    partyAddress: "",
    transport: "",
    packing: "",
    patta: "",
    stamping: "",
    quality: "",
    cut: "",
    rate: "",
    qtyPerBale: "",
    colors: [{ key: makeId(), colorNo: "", qty: "" }]
  };
}

export default function App() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [salesState, setSalesState] = useState(EMPTY_STATE);
  const [screen, setScreen] = useState("dashboard");
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [orderForm, setOrderForm] = useState(emptyOrderForm());
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [dispatchDate, setDispatchDate] = useState(isoDate());
  const [masterEdit, setMasterEdit] = useState(null);

  const adminName = profileName(profile, session);

  const loadProfile = useCallback(async (userEmail) => {
    const { data, error } = await supabase
      .from("sales_profiles")
      .select("*")
      .eq("login_email", normalize(userEmail))
      .eq("active", true)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("Admin login not found or inactive.");
    if (normalize(data.role) !== "admin") throw new Error("Only Sales Admin can use MTM.");
    setProfile(data);
    return data;
  }, []);

  const normalizeState = useCallback((raw) => ({
    parties: Array.isArray(raw?.parties) ? raw.parties : [],
    misc: Array.isArray(raw?.misc) ? raw.misc : [],
    orders: Array.isArray(raw?.orders) ? raw.orders : [],
    agents: Array.isArray(raw?.agents) ? raw.agents : [],
    staffs: Array.isArray(raw?.staffs) ? raw.staffs : []
  }), []);

  const loadSalesState = useCallback(async () => {
    const { data, error } = await supabase.from("sales_state").select("data").eq("id", "main").maybeSingle();
    if (error) throw error;
    const next = normalizeState(data?.data || EMPTY_STATE);
    setSalesState(next);
    return next;
  }, [normalizeState]);

  const saveState = useCallback(async (nextState, message = "Saved") => {
    setBusy(true);
    try {
      const normalized = normalizeState(nextState);
      const { error } = await withTimeout(
        supabase.from("sales_state").upsert(
          { id: "main", data: normalized, updated_at: new Date().toISOString() },
          { onConflict: "id" }
        ),
        "Cloud save timed out."
      );
      if (error) throw error;
      setSalesState(normalized);
      if (message) Alert.alert("Success", message);
      return normalized;
    } catch (error) {
      Alert.alert("Save Failed", error.message || "Could not save to cloud.");
      throw error;
    } finally {
      setBusy(false);
    }
  }, [normalizeState]);

  useEffect(() => {
    ScreenCapture.preventScreenCaptureAsync().catch(() => {});
    let mounted = true;
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!mounted) return;
        const current = data.session || null;
        setSession(current);
        if (current?.user?.email) {
          await withTimeout(loadProfile(current.user.email), "Admin profile load timed out.");
          await withTimeout(loadSalesState(), "Sales data load timed out.");
        }
      } catch (error) {
        Alert.alert("Login Check Failed", error.message || "Please login again.");
        await supabase.auth.signOut();
        setSession(null);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [loadProfile, loadSalesState]);

  useEffect(() => {
    if (!session) return undefined;
    const channel = supabase
      .channel("mtm-admin-sales-state")
      .on("postgres_changes", { event: "*", schema: "public", table: "sales_state", filter: "id=eq.main" }, (payload) => {
        if (payload.new?.data) setSalesState(normalizeState(payload.new.data));
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [normalizeState, session]);

  useEffect(() => {
    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      if (menuOpen) {
        setMenuOpen(false);
        return true;
      }
      if (selectedOrder) {
        setSelectedOrder(null);
        return true;
      }
      if (screen !== "dashboard") {
        setScreen("dashboard");
        setQuery("");
        return true;
      }
      return false;
    });
    return () => handler.remove();
  }, [menuOpen, screen, selectedOrder]);

  const login = async () => {
    if (!clean(email) || !password) return Alert.alert("Login", "Enter email and password.");
    setBusy(true);
    try {
      const { data, error } = await withTimeout(supabase.auth.signInWithPassword({ email: normalize(email), password }), "Login timed out.");
      if (error) throw error;
      await loadProfile(data.user.email);
      await loadSalesState();
      setSession(data.session);
    } catch (error) {
      await supabase.auth.signOut();
      Alert.alert("Login Failed", error.message || "Could not login.");
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
    setSalesState(EMPTY_STATE);
    setScreen("dashboard");
  };

  const navigate = (next) => {
    setScreen(next);
    setMenuOpen(false);
    setSelectedOrder(null);
    setQuery("");
    setMasterEdit(null);
  };

  const refresh = async () => {
    setBusy(true);
    try {
      await loadSalesState();
      setQuery("");
      setSelectedOrder(null);
    } catch (error) {
      Alert.alert("Refresh Failed", error.message || "Could not load cloud data.");
    } finally {
      setBusy(false);
    }
  };

  const dashboard = useMemo(() => {
    const orders = salesState.orders || [];
    return {
      orders: orders.length,
      pending: orders.filter((order) => !["packed", "completed", "cancelled"].includes(normalize(orderStatus(order)))).length,
      completed: orders.filter((order) => ["packed", "completed"].includes(normalize(orderStatus(order)))).length,
      bales: orders.reduce((sum, order) => sum + (order.bales || []).length, 0),
      qty: orders.reduce((sum, order) => sum + getOrderTotal(order), 0),
      pendingQty: orders.reduce((sum, order) => sum + Math.max(0, getPendingQty(order)), 0)
    };
  }, [salesState.orders]);

  const filteredOrders = useMemo(() => {
    const key = normalize(query);
    return [...(salesState.orders || [])]
      .filter((order) => !key || orderSearchText(order).includes(key))
      .sort((a, b) => new Date(b.createdAt || b.orderDate || 0) - new Date(a.createdAt || a.orderDate || 0));
  }, [query, salesState.orders]);

  const dispatchRows = useMemo(() => {
    const rows = [];
    (salesState.orders || []).forEach((order) => {
      (order.bales || []).forEach((bale) => {
        const createdAt = bale.createdAt || bale.updatedAt;
        if (createdAt && isoDate(new Date(createdAt)) === dispatchDate) {
          rows.push({
            id: `${order.id}-${bale.baleNo}`,
            createdAt,
            mtmOrderNo: order.mtmOrderNo || "-",
            partyOrderNo: order.partyOrderNo || "-",
            partyName: order.partyName || "-",
            agentName: order.agentName || "-",
            qty: Number(bale.totalQty || 0),
            member: clean(bale.staff || order.assignedStaffName || order.assignedStaff || "-").replace(/@.*/, "")
          });
        }
      });
    });
    return rows.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }, [dispatchDate, salesState.orders]);

  const pendingSummary = useMemo(() => {
    const color = {};
    const quality = {};
    const agent = {};
    const member = {};
    (salesState.orders || []).filter((order) => normalize(orderStatus(order)) !== "cancelled").forEach((order) => {
      (order.colors || []).forEach((row) => {
        const qty = Number(row.pendingQty ?? row.qty ?? 0);
        if (!qty) return;
        const colorKey = clean(row.colorNo) || "N/A";
        color[colorKey] = (color[colorKey] || 0) + qty;
        const qualityKey = clean(order.quality) || "N/A";
        quality[qualityKey] = (quality[qualityKey] || 0) + qty;
        const agentKey = clean(order.agentName) || "N/A";
        agent[agentKey] = (agent[agentKey] || 0) + qty;
        const memberKey = clean(order.assignedStaffName || order.assignedStaff) || "Not Assigned";
        member[memberKey] = (member[memberKey] || 0) + qty;
      });
    });
    const rows = (object) => Object.entries(object).sort((a, b) => b[1] - a[1]);
    return { color: rows(color), quality: rows(quality), agent: rows(agent), member: rows(member) };
  }, [salesState.orders]);

  const setForm = (key, value) => setOrderForm((current) => ({ ...current, [key]: value }));

  const selectParty = (name) => {
    const party = salesState.parties.find((item) => normalize(item.partyName) === normalize(name));
    setOrderForm((current) => ({
      ...current,
      partyName: name,
      gstNo: party?.gstNo || "",
      agentName: party?.agentName || "",
      agentEmail: party?.agentEmail || "",
      partyAddress: party?.address || ""
    }));
  };

  const updateColor = (key, field, value) => {
    setOrderForm((current) => ({
      ...current,
      colors: current.colors.map((row) => row.key === key ? { ...row, [field]: value } : row)
    }));
  };

  const addColor = () => setOrderForm((current) => ({
    ...current,
    colors: [...current.colors, { key: makeId(), colorNo: "", qty: "" }]
  }));

  const removeColor = (key) => setOrderForm((current) => ({
    ...current,
    colors: current.colors.length === 1 ? current.colors : current.colors.filter((row) => row.key !== key)
  }));

  const collectColors = () => {
    const merged = {};
    orderForm.colors.forEach((row) => {
      const colorNo = clean(row.colorNo);
      const qty = Number(row.qty || 0);
      if (!colorNo && !qty) return;
      if (!colorNo) throw new Error("Color No. / Color Name is required.");
      if (!(qty > 0)) throw new Error(`QTY must be greater than 0 for ${colorNo}.`);
      const key = normalize(colorNo);
      if (!merged[key]) merged[key] = { colorNo, qty: 0 };
      merged[key].qty += qty;
    });
    return Object.values(merged);
  };

  const saveOrder = async () => {
    try {
      const colors = collectColors();
      if (!clean(orderForm.mtmOrderNo)) throw new Error("MTM Order No. is required.");
      if (!clean(orderForm.partyName)) throw new Error("Party is required.");
      if (!clean(orderForm.agentEmail)) throw new Error("Selected party must have an agent.");
      if (!clean(orderForm.packing) || !clean(orderForm.patta) || !clean(orderForm.stamping) || !clean(orderForm.transport)) {
        throw new Error("Packing, Patta, Stamping and Transport are required.");
      }
      if (!(Number(orderForm.qtyPerBale) > 0)) throw new Error("QTY Per Bale is required.");
      if (!colors.length) throw new Error("Add at least one color.");

      const next = clone(salesState);
      const old = orderForm.id ? next.orders.find((item) => item.id === orderForm.id) : null;
      const oldPending = {};
      (old?.colors || []).forEach((row) => { oldPending[normalize(row.colorNo)] = Number(row.pendingQty ?? row.qty ?? 0); });
      const totalQty = colors.reduce((sum, row) => sum + row.qty, 0);
      const data = {
        mtmOrderNo: clean(orderForm.mtmOrderNo),
        partyOrderNo: clean(orderForm.partyOrderNo),
        orderDate: orderForm.orderDate || isoDate(),
        partyName: clean(orderForm.partyName),
        gstNo: clean(orderForm.gstNo),
        agentName: clean(orderForm.agentName),
        agentEmail: normalize(orderForm.agentEmail),
        partyAddress: clean(orderForm.partyAddress),
        transport: clean(orderForm.transport),
        transportName: clean(orderForm.transport),
        packing: clean(orderForm.packing),
        packingName: clean(orderForm.packing),
        patta: clean(orderForm.patta),
        pattaName: clean(orderForm.patta),
        stamping: clean(orderForm.stamping),
        stampingName: clean(orderForm.stamping),
        quality: clean(orderForm.quality),
        cut: clean(orderForm.cut),
        rate: Number(orderForm.rate || 0),
        qtyPerBale: Number(orderForm.qtyPerBale),
        totalQty,
        expectedBales: expectedBales(totalQty, orderForm.qtyPerBale),
        colors: colors.map((row) => ({ ...row, pendingQty: old ? (oldPending[normalize(row.colorNo)] ?? row.qty) : row.qty })),
        updatedAt: new Date().toISOString(),
        updatedBy: session.user.email
      };
      if (old) Object.assign(old, data);
      else next.orders.push({
        id: makeId(),
        ...data,
        assignedStaff: "",
        assignedStaffName: "",
        assignmentStatus: "Not Assigned Yet",
        status: "Not Assigned Yet",
        bales: [],
        createdAt: new Date().toISOString(),
        createdBy: session.user.email
      });
      await saveState(next, old ? "Order updated" : "Order created");
      setOrderForm(emptyOrderForm());
      setScreen("orders");
    } catch (error) {
      Alert.alert("Order Error", error.message || "Could not save order.");
    }
  };

  const editOrder = (order) => {
    setOrderForm({
      id: order.id,
      mtmOrderNo: order.mtmOrderNo || "",
      partyOrderNo: order.partyOrderNo || "",
      orderDate: order.orderDate || isoDate(),
      partyName: order.partyName || "",
      gstNo: order.gstNo || "",
      agentName: order.agentName || "",
      agentEmail: order.agentEmail || "",
      partyAddress: order.partyAddress || "",
      transport: order.transport || order.transportName || "",
      packing: order.packing || order.packingName || "",
      patta: order.patta || order.pattaName || "",
      stamping: order.stamping || order.stampingName || "",
      quality: order.quality || "",
      cut: order.cut || "",
      rate: String(order.rate || ""),
      qtyPerBale: String(order.qtyPerBale || ""),
      colors: (order.colors || []).map((row) => ({ key: makeId(), colorNo: String(row.colorNo || ""), qty: String(row.qty || "") }))
    });
    setScreen("orderForm");
    setSelectedOrder(null);
  };

  const deleteOrder = (order) => Alert.alert("Delete Order", `Delete order ${order.mtmOrderNo}?`, [
    { text: "Cancel", style: "cancel" },
    {
      text: "Delete",
      style: "destructive",
      onPress: async () => {
        const next = clone(salesState);
        next.orders = next.orders.filter((item) => item.id !== order.id);
        await saveState(next, "Order deleted");
        setSelectedOrder(null);
      }
    }
  ]);

  const assignOrder = (order, staffEmail) => {
    const staff = salesState.staffs.find((item) => normalize(item.email) === normalize(staffEmail));
    const next = clone(salesState);
    const target = next.orders.find((item) => item.id === order.id);
    target.assignedStaff = staff?.email || "";
    target.assignedStaffName = staff?.name || "";
    target.assignmentStatus = staff ? "Assigned" : "Not Assigned Yet";
    if (!["Packed", "Completed", "Cancelled"].includes(target.status)) target.status = staff ? "Assigned" : "Not Assigned Yet";
    target.assignedAt = staff ? new Date().toISOString() : "";
    saveState(next, staff ? `Assigned to ${staff.name}` : "Moved to Not Assigned Yet");
    setSelectedOrder(target);
  };

  const togglePaid = async (order) => {
    const next = clone(salesState);
    const target = next.orders.find((item) => item.id === order.id);
    const locked = !isLocked(target);
    target.adminPaidLocked = locked;
    target.manualPaidByAdmin = locked;
    target.manualPaidAt = locked ? new Date().toISOString() : "";
    target.manualPaidBy = locked ? session.user.email : "";
    await saveState(next, locked ? "Order marked completed by admin" : "Order unlocked");
    setSelectedOrder(target);
  };

  const deleteBale = (order, baleNo) => Alert.alert("Delete Bale", `Delete Bale ${baleNo} and restore its QTY?`, [
    { text: "Cancel", style: "cancel" },
    {
      text: "Delete",
      style: "destructive",
      onPress: async () => {
        const next = clone(salesState);
        const target = next.orders.find((item) => item.id === order.id);
        const bale = (target.bales || []).find((item) => Number(item.baleNo) === Number(baleNo));
        getBaleRows(bale).forEach((packed) => {
          const color = target.colors.find((row) => normalize(row.colorNo) === normalize(packed.colorNo));
          if (color) color.pendingQty = Number(color.pendingQty || 0) + Number(packed.qty || 0);
        });
        target.bales = (target.bales || []).filter((item) => Number(item.baleNo) !== Number(baleNo));
        target.bales.forEach((item, index) => { item.baleNo = index + 1; });
        target.status = getPendingQty(target) > 0 ? "In Packing" : "Packed";
        await saveState(next, "Bale deleted and QTY restored");
        setSelectedOrder(target);
      }
    }
  ]);

  const printPending = async (order) => {
    const rows = (order.colors || []).filter((row) => Number(row.pendingQty ?? row.qty ?? 0) !== 0);
    const htmlRows = rows.map((row) => `<tr><td>${row.colorNo}</td><td>${row.pendingQty ?? row.qty} pcs</td></tr>`).join("");
    await Print.printAsync({
      html: `<html><head><style>@page{size:A4;margin:12mm}body{font-family:Arial}table{width:100%;border-collapse:collapse}th,td{border:1px solid #444;padding:8px}th{background:#dbeafe}</style></head><body><h1>MONICA TEXTILE MILLS</h1><h2>Pending Colors Report</h2><p><b>Party Conf No:</b> ${order.partyOrderNo || "-"} / <b>MTM Conf No:</b> ${order.mtmOrderNo || "-"}</p><p><b>Party:</b> ${order.partyName}</p><table><tr><th>Color No.</th><th>Pending QTY</th></tr>${htmlRows || "<tr><td colspan='2'>No pending colors</td></tr>"}</table></body></html>`
    });
  };

  const copyPending = async (order) => {
    const text = (order.colors || [])
      .filter((row) => Number(row.pendingQty ?? row.qty ?? 0) !== 0)
      .map((row) => `${row.colorNo}: ${row.pendingQty ?? row.qty} pcs`)
      .join("\n") || "No pending colors";
    await Clipboard.setStringAsync(text);
    Alert.alert("Copied", "Pending colors copied.");
  };

  const saveMaster = async (kind, form) => {
    try {
      const next = clone(salesState);
      const editing = masterEdit?.kind === kind ? masterEdit.item : null;
      if (kind === "agent") {
        if (!clean(form.name) || !normalize(form.email).includes("@")) throw new Error("Agent name and valid email are required.");
        const item = editing ? next.agents.find((row) => row.id === editing.id) : null;
        const oldName = item?.name;
        const oldEmail = item?.email;
        if (item) Object.assign(item, { name: clean(form.name), mobile: clean(form.mobile), email: normalize(form.email) });
        else next.agents.push({ id: makeId(), name: clean(form.name), mobile: clean(form.mobile), email: normalize(form.email) });
        if (item) {
          [...next.parties, ...next.orders].forEach((row) => {
            if (normalize(row.agentEmail) === normalize(oldEmail) || normalize(row.agentName) === normalize(oldName)) {
              row.agentName = item.name;
              row.agentEmail = item.email;
            }
          });
        }
      } else if (kind === "party") {
        const agent = next.agents.find((row) => normalize(row.email) === normalize(form.agentEmail));
        if (!clean(form.partyName) || !agent) throw new Error("Party name and agent are required.");
        const item = editing ? next.parties.find((row) => row.id === editing.id) : null;
        const data = { partyName: clean(form.partyName), gstNo: clean(form.gstNo), address: clean(form.address), phone: clean(form.phone), agentName: agent.name, agentEmail: agent.email };
        if (item) Object.assign(item, data);
        else next.parties.push({ id: makeId(), ...data });
      } else if (kind === "member") {
        if (!clean(form.name) || !normalize(form.email).includes("@")) throw new Error("Team member name and valid email are required.");
        const item = editing ? next.staffs.find((row) => row.id === editing.id) : null;
        const oldEmail = item?.email;
        if (item) Object.assign(item, { name: clean(form.name), email: normalize(form.email) });
        else next.staffs.push({ id: makeId(), name: clean(form.name), email: normalize(form.email) });
        if (item) next.orders.forEach((order) => {
          if (normalize(order.assignedStaff) === normalize(oldEmail)) {
            order.assignedStaff = item.email;
            order.assignedStaffName = item.name;
          }
        });
      } else if (kind === "misc") {
        if (!clean(form.type) || !clean(form.name)) throw new Error("Type and name are required.");
        const item = editing ? next.misc.find((row) => row.id === editing.id) : null;
        if (item) Object.assign(item, { type: clean(form.type), name: clean(form.name) });
        else next.misc.push({ id: makeId(), type: clean(form.type), name: clean(form.name) });
      }
      await saveState(next, editing ? "Updated successfully" : "Saved successfully");
      setMasterEdit(null);
    } catch (error) {
      Alert.alert("Validation", error.message);
    }
  };

  const deleteMaster = (kind, item) => Alert.alert("Delete", "Delete this record?", [
    { text: "Cancel", style: "cancel" },
    {
      text: "Delete",
      style: "destructive",
      onPress: async () => {
        const next = clone(salesState);
        const key = { agent: "agents", party: "parties", member: "staffs", misc: "misc" }[kind];
        next[key] = next[key].filter((row) => row.id !== item.id);
        await saveState(next, "Deleted successfully");
      }
    }
  ]);

  const exportBackup = async () => {
    try {
      const path = `${FileSystem.cacheDirectory}mtm-sales-backup-${isoDate()}.json`;
      await FileSystem.writeAsStringAsync(path, JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), salesState }, null, 2));
      await Sharing.shareAsync(path, { mimeType: "application/json", dialogTitle: "Export MTM Sales Backup" });
    } catch (error) {
      Alert.alert("Export Failed", error.message);
    }
  };

  const importBackup = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: "application/json", copyToCacheDirectory: true });
      if (result.canceled) return;
      const text = await FileSystem.readAsStringAsync(result.assets[0].uri);
      const parsed = JSON.parse(text);
      const imported = normalizeState(parsed.salesState || parsed);
      Alert.alert("Import Complete Backup", "This replaces Sales cloud data with the selected backup. Continue?", [
        { text: "Cancel", style: "cancel" },
        { text: "Import", style: "destructive", onPress: () => saveState(imported, "Complete Sales backup imported") }
      ]);
    } catch (error) {
      Alert.alert("Import Failed", error.message || "Invalid backup file.");
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.loadingScreen}>
        <ActivityIndicator size="large" color="#2563eb" />
        <Text style={styles.loadingText}>Loading MTM Admin...</Text>
      </SafeAreaView>
    );
  }

  if (!session) {
    return (
      <KeyboardAvoidingView style={styles.loginPage} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.loginCard}>
          <Text style={styles.loginTitle}>MTM</Text>
          <Text style={styles.loginSubtitle}>Sales Admin Portal</Text>
          <Field label="Admin Email" value={email} onChangeText={setEmail} placeholder="garvit@mtm.sales" keyboardType="email-address" />
          <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry />
          <AppButton title={busy ? "Logging in..." : "Login"} onPress={login} disabled={busy} tone="success" />
          <Text style={styles.version}>Version {APP_VERSION}</Text>
        </View>
      </KeyboardAvoidingView>
    );
  }

  const renderDashboard = () => (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.hero}>
        <Text style={styles.heroEyebrow}>MONICA TEXTILE MILLS</Text>
        <Text style={styles.heroTitle}>Sales Admin</Text>
        <Text style={styles.heroText}>Welcome, {adminName}</Text>
      </View>
      <View style={styles.statsGrid}>
        <Stat label="Total Orders" value={dashboard.orders} />
        <Stat label="Pending Orders" value={dashboard.pending} tone="amber" />
        <Stat label="Completed" value={dashboard.completed} tone="green" />
        <Stat label="Created Bales" value={dashboard.bales} />
        <Stat label="Total QTY" value={dashboard.qty} />
        <Stat label="Pending PCS" value={dashboard.pendingQty} tone="amber" />
      </View>
      <Section title="Quick Actions">
        <View style={styles.actionGrid}>
          <AppButton title="Create Order" onPress={() => { setOrderForm(emptyOrderForm()); navigate("orderForm"); }} />
          <AppButton title="Daily Dispatch" onPress={() => navigate("dispatch")} tone="success" />
          <AppButton title="Pending Summary" onPress={() => navigate("pending")} tone="muted" />
          <AppButton title="Team Reports" onPress={() => navigate("team")} tone="muted" />
        </View>
      </Section>
    </ScrollView>
  );

  const renderOrderCard = ({ item }) => (
    <Pressable style={[styles.orderCard, isLocked(item) && styles.completedCard]} onPress={() => setSelectedOrder(item)}>
      <View style={styles.orderTitleRow}>
        <Text style={styles.orderTitle}>{item.mtmOrderNo || "-"} - {item.partyName || "-"}</Text>
        <StatusBadge status={orderStatus(item)} />
      </View>
      <Text style={styles.detail}><Text style={styles.bold}>Party Conf No:</Text> {item.partyOrderNo || "-"} / <Text style={styles.bold}>MTM Conf No:</Text> {item.mtmOrderNo || "-"}</Text>
      <Text style={styles.detail}><Text style={styles.bold}>Agent:</Text> {item.agentName || "-"}</Text>
      <Text style={styles.detail}><Text style={styles.bold}>Assigned to:</Text> {item.assignedStaffName || "Not Assigned Yet"}</Text>
      <Text style={styles.detail}><Text style={styles.bold}>Quality:</Text> {item.quality || "-"} | <Text style={styles.bold}>Cut:</Text> {item.cut || "-"}</Text>
      <Text style={styles.detail}><Text style={styles.bold}>Total / Sent / Pending:</Text> {getOrderTotal(item)} / {getSentQty(item)} / {getPendingQty(item)}</Text>
      <Text style={styles.detail}><Text style={styles.bold}>Bales:</Text> {(item.bales || []).length} created / {item.expectedBales || expectedBales(getOrderTotal(item), item.qtyPerBale)} expected</Text>
    </Pressable>
  );

  const renderOrders = () => (
    <View style={styles.flex}>
      <View style={styles.listHeader}>
        <TextInput value={query} onChangeText={setQuery} placeholder="Search any order detail..." placeholderTextColor="#94a3b8" style={styles.search} />
        <AppButton title="+ New" compact onPress={() => { setOrderForm(emptyOrderForm()); setScreen("orderForm"); }} />
      </View>
      <FlatList
        data={filteredOrders}
        keyExtractor={(item) => item.id}
        renderItem={renderOrderCard}
        contentContainerStyle={styles.list}
        refreshing={busy}
        onRefresh={refresh}
        ListEmptyComponent={<Text style={styles.empty}>No orders found.</Text>}
      />
    </View>
  );

  const miscOptions = (type) => (salesState.misc || [])
    .filter((item) => normalize(item.type) === normalize(type))
    .map((item) => item.name)
    .sort((a, b) => a.localeCompare(b));

  const renderOrderForm = () => {
    const total = orderForm.colors.reduce((sum, row) => sum + Number(row.qty || 0), 0);
    return (
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <Section title={orderForm.id ? "Edit Order" : "Create Order"}>
          <View style={styles.formGrid}>
            <Field label="MTM Order No." value={orderForm.mtmOrderNo} onChangeText={(value) => setForm("mtmOrderNo", value)} />
            <Field label="Party Order No." value={orderForm.partyOrderNo} onChangeText={(value) => setForm("partyOrderNo", value)} />
            <Field label="Order Date (YYYY-MM-DD)" value={orderForm.orderDate} onChangeText={(value) => setForm("orderDate", value)} />
            <ChoiceField label="Party" value={orderForm.partyName} options={salesState.parties.map((item) => item.partyName)} onSelect={selectParty} />
            <Field label="GST No." value={orderForm.gstNo} onChangeText={(value) => setForm("gstNo", value)} />
            <Field label="Agent" value={orderForm.agentName} onChangeText={(value) => setForm("agentName", value)} />
            <Field label="Address / Station" value={orderForm.partyAddress} onChangeText={(value) => setForm("partyAddress", value)} />
            <ChoiceField label="Transport" value={orderForm.transport} options={miscOptions("transport")} onSelect={(value) => setForm("transport", value)} />
            <ChoiceField label="Packing" value={orderForm.packing} options={miscOptions("packing")} onSelect={(value) => setForm("packing", value)} />
            <ChoiceField label="Patta" value={orderForm.patta} options={miscOptions("patta")} onSelect={(value) => setForm("patta", value)} />
            <ChoiceField label="Stamping" value={orderForm.stamping} options={miscOptions("stamping")} onSelect={(value) => setForm("stamping", value)} />
            <ChoiceField label="Quality" value={orderForm.quality} options={miscOptions("quality")} onSelect={(value) => setForm("quality", value)} />
            <ChoiceField label="Cut" value={orderForm.cut} options={[...CUT_OPTIONS, ...miscOptions("cut")]} onSelect={(value) => setForm("cut", value)} />
            <Field label="Rate" value={orderForm.rate} onChangeText={(value) => setForm("rate", value)} keyboardType="decimal-pad" />
            <Field label="QTY Per Bale" value={orderForm.qtyPerBale} onChangeText={(value) => setForm("qtyPerBale", value)} keyboardType="number-pad" />
          </View>
        </Section>
        <Section title="Color Order Entry">
          {orderForm.colors.map((row) => (
            <View key={row.key} style={styles.colorRow}>
              <View style={styles.colorField}><Field label="Color No. / Name" value={row.colorNo} onChangeText={(value) => updateColor(row.key, "colorNo", value)} /></View>
              <View style={styles.qtyField}><Field label="QTY" value={row.qty} onChangeText={(value) => updateColor(row.key, "qty", value)} keyboardType="number-pad" /></View>
              <AppButton title="X" compact tone="danger" onPress={() => removeColor(row.key)} />
            </View>
          ))}
          <AppButton title="Add Color Row" tone="muted" onPress={addColor} />
          <Text style={styles.totalLine}>Total Order QTY: {total} | Expected Bales: {expectedBales(total, orderForm.qtyPerBale)}</Text>
        </Section>
        <View style={styles.bottomActions}>
          <AppButton title={busy ? "Saving..." : orderForm.id ? "Update Order" : "Save Order"} tone="success" disabled={busy} onPress={saveOrder} />
          <AppButton title="Cancel" tone="muted" onPress={() => { setOrderForm(emptyOrderForm()); setScreen("orders"); }} />
        </View>
      </ScrollView>
    );
  };

  const renderDispatch = () => (
    <View style={styles.flex}>
      <View style={styles.listHeaderColumn}>
        <Text style={styles.screenTitle}>Daily Dispatch</Text>
        <Field label="Dispatch Date (YYYY-MM-DD)" value={dispatchDate} onChangeText={setDispatchDate} />
        <Text style={styles.summaryText}>{dispatchRows.length} bales | {dispatchRows.reduce((sum, row) => sum + row.qty, 0)} QTY</Text>
      </View>
      <FlatList
        data={dispatchRows}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={styles.empty}>No bales created on this date.</Text>}
        renderItem={({ item }) => (
          <View style={styles.dispatchCard}>
            <Text style={styles.dispatchTime}>{displayDate(item.createdAt, true).split(",").slice(-1)[0].trim()}</Text>
            <Text style={styles.orderTitle}>MTM {item.mtmOrderNo} / Party {item.partyOrderNo}</Text>
            <Text style={styles.detail}><Text style={styles.bold}>Party:</Text> {item.partyName}</Text>
            <Text style={styles.detail}><Text style={styles.bold}>Agent:</Text> {item.agentName}</Text>
            <View style={styles.dispatchBottom}>
              <Text style={styles.dispatchQty}>{item.qty} QTY</Text>
              <Text style={styles.dispatchMember}>{item.member.toUpperCase()}</Text>
            </View>
          </View>
        )}
      />
    </View>
  );

  const renderPendingGroup = (title, rows) => (
    <Section title={title}>
      {rows.length ? rows.map(([name, qty]) => (
        <View key={name} style={styles.summaryRow}>
          <Text style={styles.summaryName}>{name}</Text>
          <Text style={styles.summaryQty}>{qty} QTY</Text>
        </View>
      )) : <Text style={styles.empty}>No pending data.</Text>}
    </Section>
  );

  const renderPending = () => (
    <ScrollView contentContainerStyle={styles.page}>
      {renderPendingGroup("Color No. Wise", pendingSummary.color)}
      {renderPendingGroup("Quality Wise", pendingSummary.quality)}
      {renderPendingGroup("Agent Wise", pendingSummary.agent)}
      {renderPendingGroup("Team Member Wise", pendingSummary.member)}
    </ScrollView>
  );

  const renderTeam = () => (
    <ScrollView contentContainerStyle={styles.page}>
      {(salesState.staffs || []).map((staff) => {
        const orders = salesState.orders.filter((order) => normalize(order.assignedStaff) === normalize(staff.email));
        const bales = orders.reduce((sum, order) => sum + (order.bales || []).length, 0);
        const qty = orders.reduce((sum, order) => sum + getSentQty(order), 0);
        return (
          <Section key={staff.id} title={staff.name || staff.email}>
            <View style={styles.teamStats}>
              <Text style={styles.detail}>Orders: <Text style={styles.bold}>{orders.length}</Text></Text>
              <Text style={styles.detail}>Bales: <Text style={styles.bold}>{bales}</Text></Text>
              <Text style={styles.detail}>Packed QTY: <Text style={styles.bold}>{qty}</Text></Text>
            </View>
            {orders.map((order) => (
              <Pressable key={order.id} style={styles.miniOrder} onPress={() => setSelectedOrder(order)}>
                <Text style={styles.bold}>{order.mtmOrderNo} - {order.partyName}</Text>
                <Text style={styles.detail}>{(order.bales || []).length} bales | {getSentQty(order)} sent | {getPendingQty(order)} pending</Text>
              </Pressable>
            ))}
          </Section>
        );
      })}
    </ScrollView>
  );

  const renderMaster = (kind) => {
    const config = {
      parties: { title: "Party Master", key: "parties", type: "party" },
      agents: { title: "Agent Ledger", key: "agents", type: "agent" },
      members: { title: "Team Member Ledger", key: "staffs", type: "member" },
      misc: { title: "Misc Master", key: "misc", type: "misc" }
    }[kind];
    const data = salesState[config.key] || [];
    return (
      <View style={styles.flex}>
        <View style={styles.listHeader}>
          <TextInput value={query} onChangeText={setQuery} placeholder={`Search ${config.title}...`} placeholderTextColor="#94a3b8" style={styles.search} />
          <AppButton title="+ Add" compact onPress={() => setMasterEdit({ kind: config.type, item: null })} />
        </View>
        <FlatList
          data={data.filter((item) => !normalize(query) || JSON.stringify(item).toLowerCase().includes(normalize(query)))}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.masterCard}>
              <Text style={styles.orderTitle}>{item.partyName || item.name || "-"}</Text>
              {config.type === "party" && <Text style={styles.detail}>{item.gstNo || "-"} | {item.agentName || "-"}</Text>}
              {config.type === "agent" && <Text style={styles.detail}>{item.mobile || "-"} | {item.email || "-"}</Text>}
              {config.type === "member" && <Text style={styles.detail}>{item.email || "-"}</Text>}
              {config.type === "misc" && <Text style={styles.detail}>{String(item.type || "").toUpperCase()}</Text>}
              <View style={styles.rowActions}>
                <AppButton title="Edit" compact tone="muted" onPress={() => setMasterEdit({ kind: config.type, item })} />
                <AppButton title="Delete" compact tone="danger" onPress={() => deleteMaster(config.type, item)} />
              </View>
            </View>
          )}
        />
      </View>
    );
  };

  const renderBackup = () => (
    <ScrollView contentContainerStyle={styles.page}>
      <Section title="Complete Sales Data Backup">
        <Text style={styles.paragraph}>Export all Sales orders, bales, parties, agents, team members and miscellaneous masters into one cloud-safe JSON backup.</Text>
        <AppButton title="Export Complete Backup" tone="success" onPress={exportBackup} />
        <AppButton title="Import Complete Backup" tone="muted" onPress={importBackup} />
      </Section>
    </ScrollView>
  );

  const orderModal = selectedOrder && (
    <Modal visible transparent animationType="slide" onRequestClose={() => setSelectedOrder(null)}>
      <View style={styles.fullModal}>
        <SafeAreaView style={styles.modalPage}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{selectedOrder.mtmOrderNo} - {selectedOrder.partyName}</Text>
            <AppButton title="Close" compact tone="muted" onPress={() => setSelectedOrder(null)} />
          </View>
          <ScrollView contentContainerStyle={styles.modalContent}>
            <Section title="Order Details">
              <Text style={styles.detail}><Text style={styles.bold}>Party Conf No:</Text> {selectedOrder.partyOrderNo || "-"} / <Text style={styles.bold}>MTM Conf No:</Text> {selectedOrder.mtmOrderNo || "-"}</Text>
              <Text style={styles.detail}><Text style={styles.bold}>Party:</Text> {selectedOrder.partyName}</Text>
              <Text style={styles.detail}><Text style={styles.bold}>Agent:</Text> {selectedOrder.agentName || "-"}</Text>
              <Text style={styles.detail}><Text style={styles.bold}>Quality:</Text> {selectedOrder.quality || "-"} | <Text style={styles.bold}>Cut:</Text> {selectedOrder.cut || "-"}</Text>
              <Text style={styles.detail}><Text style={styles.bold}>Stamping:</Text> {selectedOrder.stamping || "-"} | <Text style={styles.bold}>Patta:</Text> {selectedOrder.patta || "-"}</Text>
              <Text style={styles.detail}><Text style={styles.bold}>Packing:</Text> {selectedOrder.packing || "-"} | <Text style={styles.bold}>Transport:</Text> {selectedOrder.transport || "-"}</Text>
              <Text style={styles.detail}><Text style={styles.bold}>Assigned to:</Text> {selectedOrder.assignedStaffName || "Not Assigned Yet"}</Text>
              <Text style={styles.detail}><Text style={styles.bold}>Total / Sent / Pending:</Text> {getOrderTotal(selectedOrder)} / {getSentQty(selectedOrder)} / {getPendingQty(selectedOrder)}</Text>
              <StatusBadge status={orderStatus(selectedOrder)} />
              {isLocked(selectedOrder) && <Text style={styles.paidNote}>Paid manually by admin: {clean(selectedOrder.manualPaidBy || "").split("@")[0].toUpperCase() || adminName}</Text>}
            </Section>
            <Section title="Admin Actions">
              <ChoiceField
                label="Assign / Change Team Member"
                value={selectedOrder.assignedStaffName || ""}
                options={[
                  { label: "Not Assigned Yet", value: "" },
                  ...salesState.staffs.map((staff) => ({ label: staff.name, value: staff.email }))
                ]}
                onSelect={(value) => assignOrder(selectedOrder, value)}
              />
              <View style={styles.actionGrid}>
                <AppButton title="Edit Order" onPress={() => editOrder(selectedOrder)} />
                <AppButton title={isLocked(selectedOrder) ? "Unpaid / Unlock" : "Paid / Complete"} tone={isLocked(selectedOrder) ? "muted" : "success"} onPress={() => togglePaid(selectedOrder)} />
                <AppButton title="Print Pending" tone="muted" onPress={() => printPending(selectedOrder)} />
                <AppButton title="Copy Pending" tone="muted" onPress={() => copyPending(selectedOrder)} />
                <AppButton title="Delete Order" tone="danger" onPress={() => deleteOrder(selectedOrder)} />
              </View>
            </Section>
            <Section title={`Created Bales (${(selectedOrder.bales || []).length})`}>
              {(selectedOrder.bales || []).map((bale) => (
                <View key={bale.baleNo} style={styles.baleCard}>
                  <Text style={styles.orderTitle}>Bale {bale.baleNo} - {bale.totalQty} QTY</Text>
                  <Text style={styles.detail}>{displayDate(bale.createdAt, true)} | By: {clean(bale.staff || selectedOrder.assignedStaffName || "-").replace(/@.*/, "")}</Text>
                  <Text style={styles.detail}>{getBaleRows(bale).map((row) => `${row.colorNo}: ${row.qty}`).join(", ")}</Text>
                  <AppButton title="Delete Bale" compact tone="danger" onPress={() => deleteBale(selectedOrder, bale.baleNo)} />
                </View>
              ))}
              {!(selectedOrder.bales || []).length && <Text style={styles.empty}>No bales created.</Text>}
            </Section>
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );

  const masterModal = masterEdit && (
    <MasterEditor
      edit={masterEdit}
      agents={salesState.agents}
      onClose={() => setMasterEdit(null)}
      onSave={saveMaster}
    />
  );

  let content = renderDashboard();
  if (screen === "orders") content = renderOrders();
  if (screen === "orderForm") content = renderOrderForm();
  if (screen === "dispatch") content = renderDispatch();
  if (screen === "pending") content = renderPending();
  if (screen === "team") content = renderTeam();
  if (["parties", "agents", "members", "misc"].includes(screen)) content = renderMaster(screen);
  if (screen === "backup") content = renderBackup();

  return (
    <SafeAreaView style={styles.app}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <Pressable style={styles.menuButton} onPress={() => setMenuOpen(true)}><Text style={styles.menuIcon}>☰</Text></Pressable>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle}>MTM</Text>
          <Text style={styles.headerSub}>{NAV_ITEMS.find(([key]) => key === screen)?.[1] || "Order Form"}</Text>
        </View>
        <Pressable style={styles.refreshButton} onPress={refresh}><Text style={styles.refreshText}>↻</Text></Pressable>
      </View>
      {content}
      {busy && <View style={styles.busyOverlay}><ActivityIndicator size="large" color="#fff" /><Text style={styles.busyText}>Working...</Text></View>}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.drawerShade} onPress={() => setMenuOpen(false)}>
          <Pressable style={styles.drawer} onPress={(event) => event.stopPropagation()}>
            <Text style={styles.drawerBrand}>MTM</Text>
            <Text style={styles.drawerUser}>{adminName}</Text>
            <ScrollView>
              {NAV_ITEMS.map(([key, label]) => (
                <Pressable key={key} style={[styles.navItem, screen === key && styles.navItemActive]} onPress={() => navigate(key)}>
                  <Text style={[styles.navText, screen === key && styles.navTextActive]}>{label}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <AppButton title="Logout" tone="danger" onPress={logout} />
            <Text style={styles.drawerVersion}>Version {APP_VERSION}</Text>
          </Pressable>
        </Pressable>
      </Modal>
      {orderModal}
      {masterModal}
    </SafeAreaView>
  );
}

function MasterEditor({ edit, agents, onClose, onSave }) {
  const item = edit.item || {};
  const [form, setForm] = useState(() => {
    if (edit.kind === "party") return { partyName: item.partyName || "", gstNo: item.gstNo || "", address: item.address || "", phone: item.phone || "", agentEmail: item.agentEmail || "" };
    if (edit.kind === "agent") return { name: item.name || "", mobile: item.mobile || "", email: item.email || "" };
    if (edit.kind === "member") return { name: item.name || "", email: item.email || "" };
    return { type: item.type || "packing", name: item.name || "" };
  });
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.fullModal}>
        <SafeAreaView style={styles.modalPage}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{item.id ? "Edit" : "Add"} {edit.kind}</Text>
            <AppButton title="Close" compact tone="muted" onPress={onClose} />
          </View>
          <ScrollView contentContainerStyle={styles.modalContent}>
            {edit.kind === "party" && <>
              <Field label="Party Name" value={form.partyName} onChangeText={(value) => set("partyName", value)} />
              <Field label="GST No." value={form.gstNo} onChangeText={(value) => set("gstNo", value)} />
              <Field label="Address" value={form.address} onChangeText={(value) => set("address", value)} multiline />
              <Field label="Phone" value={form.phone} onChangeText={(value) => set("phone", value)} keyboardType="phone-pad" />
              <ChoiceField label="Agent" value={agents.find((agent) => normalize(agent.email) === normalize(form.agentEmail))?.name || ""} options={agents.map((agent) => ({ label: agent.name, value: agent.email }))} onSelect={(value) => set("agentEmail", value)} />
            </>}
            {edit.kind === "agent" && <>
              <Field label="Agent Name" value={form.name} onChangeText={(value) => set("name", value)} />
              <Field label="Mobile Number" value={form.mobile} onChangeText={(value) => set("mobile", value)} keyboardType="phone-pad" />
              <Field label="Agent Login Email" value={form.email} onChangeText={(value) => set("email", value)} keyboardType="email-address" />
            </>}
            {edit.kind === "member" && <>
              <Field label="Team Member Name" value={form.name} onChangeText={(value) => set("name", value)} />
              <Field label="Team Member Login Email" value={form.email} onChangeText={(value) => set("email", value)} keyboardType="email-address" />
            </>}
            {edit.kind === "misc" && <>
              <ChoiceField label="Type" value={form.type} options={["packing", "patta", "stamping", "transport", "quality", "cut"]} onSelect={(value) => set("type", value)} />
              <Field label="Name" value={form.name} onChangeText={(value) => set("name", value)} />
            </>}
            <AppButton title={item.id ? "Update" : "Save"} tone="success" onPress={() => onSave(edit.kind, form)} />
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: "#f1f5f9" },
  flex: { flex: 1 },
  loadingScreen: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#eff6ff" },
  loadingText: { marginTop: 16, color: "#334155", fontSize: 18, fontWeight: "800" },
  loginPage: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#eaf4ff" },
  loginCard: { backgroundColor: "#fff", borderRadius: 24, padding: 24, elevation: 8, shadowColor: "#0f172a", shadowOpacity: 0.12, shadowRadius: 20 },
  loginTitle: { fontSize: 42, fontWeight: "900", color: "#0f172a" },
  loginSubtitle: { fontSize: 18, color: "#64748b", marginBottom: 24, fontWeight: "700" },
  version: { textAlign: "center", color: "#94a3b8", marginTop: 16 },
  header: { height: 70, paddingHorizontal: 14, backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#e2e8f0", flexDirection: "row", alignItems: "center" },
  menuButton: { width: 46, height: 46, borderRadius: 14, backgroundColor: "#0f172a", alignItems: "center", justifyContent: "center" },
  menuIcon: { color: "#fff", fontSize: 26, fontWeight: "900" },
  headerText: { flex: 1, marginLeft: 12 },
  headerTitle: { color: "#0f172a", fontSize: 24, fontWeight: "900" },
  headerSub: { color: "#64748b", fontSize: 12, fontWeight: "700" },
  refreshButton: { width: 44, height: 44, borderRadius: 14, backgroundColor: "#dbeafe", alignItems: "center", justifyContent: "center" },
  refreshText: { color: "#1d4ed8", fontSize: 26, fontWeight: "900" },
  page: { padding: 14, paddingBottom: 40, gap: 14 },
  hero: { backgroundColor: "#123b83", borderRadius: 22, padding: 22 },
  heroEyebrow: { color: "#bfdbfe", fontWeight: "900", letterSpacing: 1 },
  heroTitle: { color: "#fff", fontSize: 34, fontWeight: "900", marginTop: 4 },
  heroText: { color: "#dbeafe", fontSize: 16, marginTop: 6 },
  statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  statCard: { width: "48%", backgroundColor: "#fff", borderRadius: 18, padding: 16, borderLeftWidth: 5, borderLeftColor: "#2563eb" },
  statGreen: { borderLeftColor: "#16a34a" },
  statAmber: { borderLeftColor: "#f59e0b" },
  statValue: { color: "#0f172a", fontSize: 28, fontWeight: "900" },
  statLabel: { color: "#64748b", fontWeight: "800", marginTop: 4 },
  card: { backgroundColor: "#fff", borderRadius: 18, padding: 15, gap: 10, borderWidth: 1, borderColor: "#e2e8f0" },
  sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { color: "#0f172a", fontSize: 20, fontWeight: "900" },
  screenTitle: { fontSize: 26, fontWeight: "900", color: "#0f172a" },
  actionGrid: { gap: 9 },
  button: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 13, backgroundColor: "#2563eb", alignItems: "center", justifyContent: "center", marginTop: 6 },
  buttonCompact: { minHeight: 38, paddingVertical: 8, paddingHorizontal: 13, marginTop: 0 },
  buttonDanger: { backgroundColor: "#dc2626" },
  buttonMuted: { backgroundColor: "#64748b" },
  buttonSuccess: { backgroundColor: "#16a34a" },
  buttonDisabled: { opacity: 0.45 },
  buttonPressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  buttonText: { color: "#fff", fontWeight: "900", fontSize: 15 },
  fieldWrap: { marginBottom: 10 },
  label: { color: "#334155", fontWeight: "800", marginBottom: 6 },
  input: { minHeight: 50, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 13, paddingHorizontal: 13, paddingVertical: 12, backgroundColor: "#fff", color: "#0f172a", fontSize: 16, justifyContent: "center" },
  inputMultiline: { minHeight: 90, textAlignVertical: "top" },
  placeholder: { color: "#94a3b8" },
  choiceText: { color: "#0f172a", fontSize: 16 },
  listHeader: { padding: 12, backgroundColor: "#fff", flexDirection: "row", gap: 8, alignItems: "center", borderBottomWidth: 1, borderBottomColor: "#e2e8f0" },
  listHeaderColumn: { padding: 14, backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#e2e8f0" },
  search: { flex: 1, minHeight: 46, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 13, paddingHorizontal: 14, color: "#0f172a", backgroundColor: "#fff" },
  list: { padding: 12, paddingBottom: 40, gap: 10 },
  orderCard: { backgroundColor: "#fff", borderRadius: 18, padding: 15, borderWidth: 1, borderColor: "#dbeafe", gap: 6 },
  completedCard: { backgroundColor: "#f1f5f9", borderColor: "#cbd5e1" },
  orderTitleRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 8 },
  orderTitle: { color: "#0f172a", fontWeight: "900", fontSize: 17, flexShrink: 1 },
  detail: { color: "#475569", fontSize: 14, lineHeight: 21 },
  bold: { fontWeight: "900", color: "#1e293b" },
  badge: { alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: "#fef3c7" },
  badgeText: { color: "#92400e", fontWeight: "900", fontSize: 12 },
  badgeGreen: { backgroundColor: "#dcfce7" },
  badgeGreenText: { color: "#166534" },
  badgeRed: { backgroundColor: "#fee2e2" },
  badgeRedText: { color: "#991b1b" },
  empty: { color: "#64748b", textAlign: "center", padding: 24, fontWeight: "700" },
  formGrid: { gap: 2 },
  colorRow: { flexDirection: "row", alignItems: "flex-end", gap: 7 },
  colorField: { flex: 1.5 },
  qtyField: { flex: 0.75 },
  totalLine: { color: "#0f172a", fontSize: 16, fontWeight: "900", marginVertical: 12 },
  bottomActions: { gap: 8, marginBottom: 20 },
  dispatchCard: { backgroundColor: "#fff", padding: 15, borderRadius: 17, borderLeftWidth: 5, borderLeftColor: "#16a34a", gap: 5 },
  dispatchTime: { color: "#2563eb", fontWeight: "900", fontSize: 15 },
  dispatchBottom: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 5 },
  dispatchQty: { color: "#166534", fontWeight: "900", fontSize: 18 },
  dispatchMember: { color: "#334155", fontWeight: "900" },
  summaryText: { color: "#334155", fontWeight: "900", marginTop: 4 },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: "#f1f5f9" },
  summaryName: { color: "#334155", fontWeight: "800", flex: 1 },
  summaryQty: { color: "#1d4ed8", fontWeight: "900" },
  teamStats: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  miniOrder: { padding: 12, backgroundColor: "#f8fafc", borderRadius: 12, borderWidth: 1, borderColor: "#e2e8f0" },
  masterCard: { backgroundColor: "#fff", borderRadius: 16, padding: 15, borderWidth: 1, borderColor: "#e2e8f0", gap: 6 },
  rowActions: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
  paragraph: { color: "#475569", lineHeight: 22 },
  paidNote: { padding: 10, borderRadius: 10, backgroundColor: "#dcfce7", color: "#166534", fontWeight: "900" },
  baleCard: { padding: 12, backgroundColor: "#f8fafc", borderRadius: 13, borderWidth: 1, borderColor: "#dbeafe", gap: 6 },
  busyOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(15,23,42,0.55)", alignItems: "center", justifyContent: "center", zIndex: 100 },
  busyText: { color: "#fff", marginTop: 10, fontWeight: "900" },
  drawerShade: { flex: 1, backgroundColor: "rgba(15,23,42,0.45)", flexDirection: "row" },
  drawer: { width: "82%", maxWidth: 340, backgroundColor: "#0f172a", padding: 18, paddingTop: 45 },
  drawerBrand: { color: "#fff", fontSize: 34, fontWeight: "900" },
  drawerUser: { color: "#94a3b8", fontWeight: "800", marginBottom: 20 },
  navItem: { paddingVertical: 14, paddingHorizontal: 14, borderRadius: 12, marginBottom: 4 },
  navItemActive: { backgroundColor: "#2563eb" },
  navText: { color: "#cbd5e1", fontWeight: "800", fontSize: 16 },
  navTextActive: { color: "#fff" },
  drawerVersion: { color: "#64748b", textAlign: "center", marginTop: 12 },
  modalShade: { flex: 1, backgroundColor: "rgba(15,23,42,0.55)", justifyContent: "center", padding: 20 },
  choiceModal: { backgroundColor: "#fff", borderRadius: 20, padding: 16 },
  modalTitle: { color: "#0f172a", fontWeight: "900", fontSize: 20, flex: 1 },
  choiceRow: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: "#e2e8f0" },
  choiceRowText: { color: "#0f172a", fontSize: 16, fontWeight: "700" },
  fullModal: { flex: 1, backgroundColor: "#f1f5f9" },
  modalPage: { flex: 1 },
  modalHeader: { minHeight: 68, backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#e2e8f0", padding: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  modalContent: { padding: 12, paddingBottom: 50, gap: 12 }
});
