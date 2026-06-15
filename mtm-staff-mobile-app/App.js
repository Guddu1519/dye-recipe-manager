import * as Notifications from "expo-notifications";
import * as Print from "expo-print";
import * as Clipboard from "expo-clipboard";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as ScreenCapture from "expo-screen-capture";
import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  FlatList,
  Image,
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
const APP_VERSION = Constants.expoConfig?.version || Constants.manifest?.version || "1.0.0";
const CLOUD_TIMEOUT_MS = 12000;
const BALE_PHOTO_BUCKET = "bale-photos";
const BALE_PHOTO_DAYS = 30;

function normalize(value) {
  return String(value || "").trim().toLowerCase();
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

function isOrderLocked(order) {
  return !!(order?.adminPaidLocked || order?.manualPaidByAdmin);
}

function isBalePhotoExpired(bale) {
  const d = new Date(bale?.photoUploadedAt || bale?.createdAt || "");
  if (Number.isNaN(d.getTime())) return false;
  return Date.now() - d.getTime() > BALE_PHOTO_DAYS * 24 * 60 * 60 * 1000;
}

function balePhotoMessage(bale) {
  return isBalePhotoExpired(bale)
    ? "This bale was created more than 1 month ago. No photo data available."
    : "No photo proof uploaded.";
}

function markExpiredBalePhotos(state, expiredPaths = []) {
  let changed = false;
  (state.orders || []).forEach((order) => (order.bales || []).forEach((bale) => {
    if (bale.photoUrl && isBalePhotoExpired(bale)) {
      if (bale.photoPath) expiredPaths.push(bale.photoPath);
      bale.expiredPhotoPath = bale.photoPath || "";
      bale.photoUrl = "";
      bale.photoPath = "";
      bale.photoDeletedAt = bale.photoDeletedAt || new Date().toISOString();
      changed = true;
    }
  }));
  return changed;
}

function orderStation(order) {
  return order?.partyAddress || order?.address || order?.station || "-";
}

function orderTeamName(order, bale, profile) {
  return String(bale?.staff || order?.assignedStaffName || profile?.full_name || profile?.username || order?.assignedStaff || "Team Member")
    .replace(/@.*/, "")
    .trim();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[ch]);
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

function getTakenDetails(order, colorNo) {
  const key = String(colorNo || "").trim();
  return (order.bales || [])
    .map((bale) => {
      const qty = (bale.colors || [])
        .filter((row) => String(row.colorNo || "").trim() === key)
        .reduce((sum, row) => sum + Number(row.qty || 0), 0);
      return qty ? `Bale ${bale.baleNo}: ${qty} pcs` : "";
    })
    .filter(Boolean)
    .join(", ");
}

function makeSlipCopyHtml(order, bale, copyLabel, profile) {
  const items = bale.colors || [];
  const pairCount = items.length > 18 ? 3 : items.length > 9 ? 2 : 1;
  const rowsPerPair = Math.ceil(items.length / pairCount) || 1;
  const headerCells = Array.from({ length: pairCount }, () => "<th>Color No.</th><th>Pieces</th>").join("");
  const rows = Array.from({ length: rowsPerPair }, (_, rowIndex) => {
    const cells = [];
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
      const item = items[(pairIndex * rowsPerPair) + rowIndex];
      cells.push(item ? `<td>${escapeHtml(item.colorNo)}</td><td>${escapeHtml(item.qty)} pcs</td>` : "<td></td><td></td>");
    }
    return `<tr>${cells.join("")}</tr>`;
  }).join("");

  return `
    <div class="slipCopy">
      <div class="copyLabel">${escapeHtml(copyLabel).toUpperCase()}</div>
      <section class="packingSlip">
        <div class="slipHead">
          <h2>Assortment Slip</h2>
          <h2>Bale No :</h2>
          <h2>Bale ${escapeHtml(bale.baleNo)}</h2>
        </div>
        <div class="slipMeta">
          <p class="party"><b>Party:</b> ${escapeHtml(order.partyName || "-")}</p>
          <div class="metaCol">
            <p><b>Party Order No:</b> ${escapeHtml(order.partyOrderNo || "-")}</p>
            <p><b>Quality:</b> ${escapeHtml(order.quality || "-")}</p>
            <p><b>Cut:</b> ${escapeHtml(order.cut || "-")}</p>
            <p><b>Station :</b> ${escapeHtml(orderStation(order))}</p>
            <p><b>Transport:</b> ${escapeHtml(order.transport || "-")}</p>
          </div>
          <div class="metaCol">
            <p><b>Creation Time:</b> ${escapeHtml(displayDate(bale.createdAt))}</p>
            <p><b>MTM Order No:</b> ${escapeHtml(order.mtmOrderNo || "-")}</p>
            <p><b>Stamping:</b> ${escapeHtml(order.stamping || "-")}</p>
            <p><b>Packing:</b> ${escapeHtml(order.packing || "-")}</p>
            <p><b>Patta:</b> ${escapeHtml(order.patta || "-")}</p>
            <p><b>By:</b> ${escapeHtml(orderTeamName(order, bale, profile))}</p>
          </div>
        </div>
        <table>
          <thead><tr>${headerCells}</tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><th colspan="${(pairCount * 2) - 1}">Grand Total</th><th>${escapeHtml(bale.totalQty)} pcs</th></tr></tfoot>
        </table>
      </section>
      <div class="slipFooter">Monica Textile Mills, Pali</div>
    </div>
  `;
}

function makeSlipHtml(order, bales, profile) {
  const pages = bales.map((bale) => `
    <div class="page">
      ${makeSlipCopyHtml(order, bale, "Office Copy", profile)}
      ${makeSlipCopyHtml(order, bale, "Party Copy", profile)}
    </div>
  `).join("");

  return `<!doctype html>
  <html>
    <head>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        @page{size:A5 landscape;margin:6mm}
        *{box-sizing:border-box}
        html,body{width:210mm;height:148mm}
        body{font-family:Arial,sans-serif;margin:0;color:#111}
        .page{display:grid;grid-template-columns:1fr 1fr;gap:4mm;page-break-after:always;width:198mm;height:136mm}
        .slipCopy{position:relative;display:flex;flex-direction:column;height:136mm;min-height:136mm}
        .copyLabel{text-align:right;font-size:11px;margin-bottom:2px}
        .packingSlip{border:1px solid #111;flex:1;display:flex;flex-direction:column}
        .slipHead{display:grid;grid-template-columns:1fr 1fr 1fr;align-items:center;border-bottom:1px solid #111;padding:5px 8px}
        h2{margin:0;font-size:15px;white-space:nowrap}
        h2:nth-child(2){text-align:center}
        h2:nth-child(3){text-align:right}
        .slipMeta{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:5px 8px;font-size:11px}
        .party{grid-column:1 / -1;font-size:12px;font-weight:700;margin:0}
        p{margin:2px 0;line-height:1.12}
        table{width:calc(100% - 12px);margin:5px 6px;border-collapse:collapse;font-size:10.5px}
        th,td{border:1px solid #888;padding:2px 4px;text-align:left}
        th{background:#dbeafe}
        tfoot th{background:#fff}
        .slipFooter{text-align:center;font-weight:700;font-size:10px;margin-top:2px}
      </style>
    </head>
    <body>${pages}</body>
  </html>`;
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
        tone === "muted" && styles.buttonMuted,
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
  const [menuOpen, setMenuOpen] = useState(false);
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

  const completedOrderCount = assignedOrders.filter((order) => order.status === "Packed" || isOrderLocked(order)).length;

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
      throw new Error("Only team member accounts can use this Team app.");
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
    const expiredPaths = [];
    const hadExpired = markExpiredBalePhotos(nextState, expiredPaths);
    if (expiredPaths.length) {
      supabase.storage.from(BALE_PHOTO_BUCKET).remove(expiredPaths).catch(() => {});
    }
    if (hadExpired) {
      supabase.from("sales_state").upsert({ id: "main", data: nextState, updated_at: new Date().toISOString() }, { onConflict: "id" }).then(() => {}).catch(() => {});
    }
    setSalesState(nextState);
    return nextState;
  }, []);

  const saveSalesState = useCallback(async (nextState) => {
    markExpiredBalePhotos(nextState);
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
      await withTimeout(loadSalesState(), "Refresh is taking too long. Please check internet and try again.");
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
        ScreenCapture.preventScreenCaptureAsync().catch(() => {});
        Notifications.requestPermissionsAsync().catch(() => {});
        const { data } = await withTimeout(supabase.auth.getSession(), "Login check is taking too long. Please reopen and try again.");
        if (!mounted) return;
        setSession(data.session || null);
        if (data.session?.user?.email) {
          await withTimeout(loadProfile(data.session.user.email), "Profile load is taking too long. Please check internet.");
          await withTimeout(loadSalesState(), "Order load is taking too long. Please check internet.");
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
          await withTimeout(loadProfile(nextSession.user.email), "Profile load is taking too long. Please check internet.");
          await withTimeout(loadSalesState(), "Order load is taking too long. Please check internet.");
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

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (selectedOrderId) {
        setSelectedOrderId(null);
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [selectedOrderId]);

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
    await supabase.auth.signOut();
    setSelectedOrderId(null);
    setPackingQty({});
    setQuery("");
  }

  function showAppVersion() {
    setMenuOpen(false);
    Alert.alert("MTM - Team", `Version ${APP_VERSION}`);
  }

  async function uploadBalePhoto(orderId, baleNo, stateSource = salesState) {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Camera Permission", "Allow camera access to click live bale proof photo.");
      return;
    }
    const picked = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.75,
      allowsEditing: false
    });
    if (picked.canceled || !picked.assets?.[0]?.uri) return;
    const order = (stateSource.orders || []).find((item) => String(item.id) === String(orderId));
    const bale = (order?.bales || []).find((item) => Number(item.baleNo) === Number(baleNo));
    if (!order || !bale) {
      Alert.alert("Photo Upload Failed", "Bale not found.");
      return;
    }
    try {
      const compressed = await ImageManipulator.manipulateAsync(
        picked.assets[0].uri,
        [{ resize: { width: 1200 } }],
        { compress: 0.68, format: ImageManipulator.SaveFormat.JPEG }
      );
      const response = await fetch(compressed.uri);
      const arrayBuffer = await response.arrayBuffer();
      const safeOrder = String(order.mtmOrderNo || order.id || "order").replace(/[^a-z0-9_-]/gi, "_");
      const path = `${safeOrder}/bale-${bale.baleNo}-${Date.now()}.jpg`;
      const { error } = await supabase.storage.from(BALE_PHOTO_BUCKET).upload(path, arrayBuffer, {
        contentType: "image/jpeg",
        upsert: true
      });
      if (error) throw error;
      const { data } = supabase.storage.from(BALE_PHOTO_BUCKET).getPublicUrl(path);
      const nextState = {
        ...stateSource,
        orders: (stateSource.orders || []).map((item) => {
          if (String(item.id) !== String(orderId)) return item;
          return {
            ...item,
            bales: (item.bales || []).map((existing) =>
              Number(existing.baleNo) === Number(baleNo)
                ? {
                    ...existing,
                    photoUrl: data?.publicUrl || "",
                    photoPath: path,
                    photoUploadedAt: new Date().toISOString(),
                    photoDeletedAt: ""
                  }
                : existing
            )
          };
        })
      };
      await saveSalesState(nextState);
      Alert.alert("Photo Uploaded", "Bale photo proof saved.");
    } catch (error) {
      Alert.alert("Photo Upload Failed", (error.message || "Could not upload photo.") + "\nCreate Supabase Storage bucket: bale-photos");
    }
  }

  async function updateOrderStatus(orderId, status) {
    const order = salesState.orders.find((item) => String(item.id) === String(orderId));
    if (isOrderLocked(order)) {
      Alert.alert("Order Locked", "This order is manually paid by admin. You can view and print bales only.");
      return;
    }
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
    if (isOrderLocked(selectedOrder)) {
      Alert.alert("Order Locked", "This order is manually paid by admin. You can view and print bales only.");
      return;
    }
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
      Alert.alert("Bale Created", `Bale ${nextBale.baleNo} saved successfully.`, [
        { text: "Upload Photo", onPress: () => uploadBalePhoto(selectedOrder.id, nextBale.baleNo, nextState) },
        { text: "Later" }
      ]);
    } catch (error) {
      Alert.alert("Bale Save Failed", error.message || "Could not save bale.");
    }
  }

  async function printBales(order, baleNo = null) {
    const bales = (order?.bales || []).filter((bale) => (baleNo ? Number(bale.baleNo) === Number(baleNo) : true));
    if (!bales.length) {
      Alert.alert("No Bales", "No completed bales found for assortment slip.");
      return;
    }
    try {
      await Print.printAsync({
        html: makeSlipHtml(order, bales, profile),
        orientation: Print.Orientation.landscape
      });
    } catch (error) {
      Alert.alert("Print Failed", error.message || "Could not open print/save PDF.");
    }
  }

  function showPendingReport(order) {
    const lines = getPendingRows(order)
      .filter((row) => Number(row.pending || 0) !== 0)
      .map((row) => `${row.colorNo}: ${row.pending} pcs`);
    const text = lines.length ? lines.join("\n") : "No pending colors for this order.";
    Alert.alert(
      "Pending Colors Report",
      text,
      [
        {
          text: "Copy",
          onPress: async () => {
            await Clipboard.setStringAsync(text);
            Alert.alert("Copied", "Pending report copied.");
          }
        },
        { text: "OK" }
      ]
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color="#1d4ed8" />
        <Text style={styles.loadingText}>Loading MTM Team...</Text>
      </SafeAreaView>
    );
  }

  if (!session) {
    return (
      <SafeAreaView style={styles.loginScreen}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.loginCard}>
          <Text style={styles.loginTitle}>MTM Team</Text>
          <Text style={styles.loginSub}>Login once. Your session stays active until logout.</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="Team member email"
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
          <Text style={styles.title}>Team Member Portal</Text>
          <Text style={styles.subTitle}>{profile?.full_name || profile?.username || session.user.email}</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable style={styles.menuButton} onPress={() => setMenuOpen((value) => !value)}>
            <Text style={styles.menuDots}>...</Text>
          </Pressable>
          {menuOpen && (
            <View style={styles.menuPanel}>
              <Pressable style={styles.menuItem} onPress={showAppVersion}>
                <Text style={styles.menuItemText}>Version {APP_VERSION}</Text>
              </Pressable>
              <Pressable style={styles.menuItem} onPress={handleLogout}>
                <Text style={[styles.menuItemText, styles.menuLogoutText]}>Logout</Text>
              </Pressable>
            </View>
          )}
        </View>
      </View>

      <View style={styles.statsRow}>
        <View style={styles.statCard}><Text style={styles.statNo}>{assignedOrders.length}</Text><Text>Assigned</Text></View>
        <View style={styles.statCard}><Text style={styles.statNo}>{assignedOrders.filter((o) => o.status === "In Packing").length}</Text><Text>In Process</Text></View>
        <View style={styles.statCard}><Text style={styles.statNo}>{completedOrderCount}</Text><Text>Completed</Text></View>
      </View>

      <View style={styles.toolbar}>
        <TextInput value={query} onChangeText={setQuery} placeholder="Search order, party, agent, quality..." placeholderTextColor="#64748b" style={styles.search} />
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
          const locked = isOrderLocked(item);
          const status = locked ? "Completed" : item.status || "Assigned";
          return (
            <Pressable onPress={() => setSelectedOrderId(String(item.id))} style={[styles.orderCard, locked && styles.completedOrderCard, String(item.id) === String(selectedOrderId) && styles.orderActive]}>
              <View style={styles.orderTop}>
                <Text style={styles.orderNo}>{item.mtmOrderNo || "Order"} - {item.partyName || "-"}</Text>
              </View>
              <Text style={styles.metaStrong}>Party Order: <Text style={styles.metaValue}>{item.partyOrderNo || "-"}</Text></Text>
              <Text style={styles.metaStrong}>Agent: <Text style={styles.metaValue}>{item.agentName || "-"}</Text></Text>
              <View style={styles.qualityLine}>
                <Text style={styles.metaStrong}>Quality: </Text>
                <Text style={styles.qualityBadge}>{item.quality || "-"}</Text>
                <Text style={styles.metaStrong}>Cut: <Text style={styles.metaValue}>{item.cut || "-"}</Text></Text>
              </View>
              <Text style={styles.meta}>Stamping: {item.stamping || "-"} | Patta: {item.patta || "-"} | Packing: {item.packing || "-"}</Text>
              <Text style={styles.meta}>Station: {orderStation(item)} | Transport: {item.transport || "-"}</Text>
              <Text style={styles.metaStrong}>Total / Sent / Pending: {total} / {sent} / {total - sent}</Text>
              <View style={styles.statusLine}>
                <Text style={styles.metaStrong}>Status: </Text>
                <Text style={[styles.status, locked && styles.statusLocked]}>{status}</Text>
              </View>
              <View style={styles.rowActions}>
                {locked ? (
                  <AppButton title="View / Print Bales" tone="muted" onPress={() => setSelectedOrderId(String(item.id))} />
                ) : status === "Assigned" ? (
                  <AppButton title="Accept Order" onPress={() => updateOrderStatus(item.id, "Accepted")} />
                ) : (
                  <AppButton title="Start Bale Creation" onPress={() => setSelectedOrderId(String(item.id))} />
                )}
                <AppButton title="Pending Report" onPress={() => showPendingReport(item)} tone="ghost" />
              </View>
            </Pressable>
          );
        }}
      />

      {selectedOrder && (
        <View style={styles.workSheet}>
          <ScrollView contentContainerStyle={styles.workScroll}>
            <View style={styles.workHeader}>
              <AppButton title="Back" onPress={() => setSelectedOrderId(null)} tone="ghost" />
              <Text style={styles.sheetTitle}>Bale Creation</Text>
            </View>
            <Text style={styles.sheetSub}>{selectedOrder.mtmOrderNo} - {selectedOrder.partyName}</Text>
            {isOrderLocked(selectedOrder) && <Text style={styles.lockNote}>Status: Completed. Printing is available.</Text>}
            {!isOrderLocked(selectedOrder) && getPendingRows(selectedOrder).map((row) => {
              const alreadyTaken = getTakenDetails(selectedOrder, row.colorNo);
              const completed = row.pending <= 0;
              return (
              <View key={row.colorNo} style={[styles.colorRow, completed && styles.colorCompleted]}>
                <View style={styles.colorTopLine}>
                  <Text style={styles.metaStrong}>Ordered: {row.ordered} pcs</Text>
                  <Text style={styles.metaStrong}>Pending: {row.pending} pcs</Text>
                </View>
                <View style={styles.colorBody}>
                  <Text style={styles.colorNo}>{row.colorNo}</Text>
                  <View style={styles.colorInfo}>
                    {completed ? <Text style={styles.completedBadge}>Completed</Text> : null}
                    {alreadyTaken ? <Text style={styles.takenText}>Already Taken: {alreadyTaken}</Text> : null}
                  </View>
                </View>
                {!completed && (
                  <>
                    <View style={styles.qtyChoiceRow}>
                      <Pressable
                        style={styles.choiceBox}
                        onPress={() => setPackingQty((current) => ({ ...current, [row.colorNo]: String(row.pending) }))}
                      >
                        <View style={[styles.fakeCheck, Number(packingQty[row.colorNo] || 0) === row.pending && styles.fakeCheckOn]} />
                        <Text style={styles.choiceText}>Full QTY</Text>
                      </Pressable>
                      <Pressable
                        style={styles.choiceBox}
                        onPress={() => setPackingQty((current) => ({ ...current, [row.colorNo]: current[row.colorNo] || "" }))}
                      >
                        <View style={[styles.fakeCheck, packingQty[row.colorNo] && Number(packingQty[row.colorNo]) !== row.pending && styles.fakeCheckOn]} />
                        <Text style={styles.choiceText}>Custom</Text>
                      </Pressable>
                    </View>
                    <TextInput
                      value={packingQty[row.colorNo] || ""}
                      onChangeText={(value) => setPackingQty((current) => ({ ...current, [row.colorNo]: value.replace(/[^0-9.]/g, "") }))}
                      keyboardType="numeric"
                      placeholder="Enter QTY"
                      placeholderTextColor="#64748b"
                      style={styles.qtyInput}
                    />
                  </>
                )}
              </View>
            );})}
            {(selectedOrder.bales || []).length > 0 && (
              <View style={styles.baleHistory}>
                <Text style={styles.sheetTitle}>Bales</Text>
                <AppButton title="Print All Bales" onPress={() => printBales(selectedOrder)} tone="ghost" />
                {(selectedOrder.bales || []).map((bale) => (
                  <View key={bale.baleNo} style={styles.baleCard}>
                    <Text style={styles.metaStrong}>Bale {bale.baleNo}: {bale.totalQty} pcs</Text>
                    <Text style={styles.meta}>Created: {displayDate(bale.createdAt)}</Text>
                    <Text style={styles.meta}>{(bale.colors || []).map((row) => `${row.colorNo}: ${row.qty}`).join(", ")}</Text>
                    {bale.photoUrl && !isBalePhotoExpired(bale) ? (
                      <Image source={{ uri: bale.photoUrl }} style={styles.balePhoto} />
                    ) : (
                      <Text style={styles.photoNote}>{balePhotoMessage(bale)}</Text>
                    )}
                    <AppButton title="Print This Bale" onPress={() => printBales(selectedOrder, bale.baleNo)} tone="ghost" />
                  </View>
                ))}
              </View>
            )}
          </ScrollView>
          <View style={styles.fixedActions}>
            <View style={styles.floatingTotals}>
              <Text style={styles.floatingLabel}>QTY Per Bale: {selectedOrder.qtyPerBale || "-"}</Text>
              <Text style={styles.floatingLabel}>Selected Total: <Text style={styles.floatingTotalNo}>{selectedTotal}</Text></Text>
            </View>
            <AppButton title="Clear QTY" onPress={() => setPackingQty({})} tone="ghost" />
            {!isOrderLocked(selectedOrder) && <AppButton title="Create Bale" onPress={createBale} />}
          </View>
        </View>
      )}
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
  input: { borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 14, padding: 14, marginBottom: 12, backgroundColor: "#fff", color: "#0f172a", fontSize: 16 },
  header: { padding: 16, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontSize: 28, fontWeight: "900", color: "#0f172a" },
  subTitle: { color: "#64748b", fontWeight: "700", marginTop: 4 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8, position: "relative" },
  bell: { minWidth: 54, minHeight: 54, borderRadius: 18, backgroundColor: "#0f172a", alignItems: "center", justifyContent: "center" },
  bellText: { color: "#fff", fontWeight: "900" },
  menuButton: { width: 48, height: 54, borderRadius: 18, backgroundColor: "#0f172a", alignItems: "center", justifyContent: "center" },
  menuDots: { color: "#fff", fontSize: 30, fontWeight: "900", lineHeight: 32 },
  menuPanel: { position: "absolute", right: 0, top: 62, zIndex: 50, minWidth: 190, backgroundColor: "#fff", borderRadius: 18, borderWidth: 1, borderColor: "#dbeafe", shadowColor: "#0f172a", shadowOpacity: 0.18, shadowRadius: 18, elevation: 8, overflow: "hidden" },
  menuItem: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: "#e5eefb" },
  menuItemText: { color: "#0f172a", fontWeight: "900", fontSize: 16 },
  menuLogoutText: { color: "#dc2626" },
  badge: { position: "absolute", top: -6, right: -6, backgroundColor: "#ef4444", color: "#fff", borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2, fontWeight: "900" },
  statsRow: { flexDirection: "row", gap: 10, paddingHorizontal: 16 },
  statCard: { flex: 1, backgroundColor: "#fff", borderRadius: 18, padding: 14, borderWidth: 1, borderColor: "#dbeafe" },
  statNo: { color: "#1d4ed8", fontWeight: "900", fontSize: 28 },
  toolbar: { padding: 16, gap: 10 },
  search: { borderWidth: 1, borderColor: "#bfdbfe", backgroundColor: "#fff", color: "#0f172a", borderRadius: 16, padding: 13, fontSize: 16 },
  list: { padding: 16, paddingBottom: 110 },
  empty: { textAlign: "center", color: "#64748b", padding: 25, fontWeight: "700" },
  orderCard: { backgroundColor: "#fff", borderRadius: 20, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: "#dbeafe" },
  completedOrderCard: { backgroundColor: "#f8fafc", borderColor: "#cbd5e1" },
  orderActive: { borderColor: "#2563eb", borderWidth: 2 },
  orderTop: { flexDirection: "row", justifyContent: "space-between", gap: 10 },
  orderNo: { fontSize: 22, fontWeight: "900", color: "#0f172a" },
  status: { color: "#92400e", backgroundColor: "#fef3c7", overflow: "hidden", paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, fontWeight: "900" },
  statusLocked: { color: "#166534", backgroundColor: "#dcfce7" },
  statusLine: { flexDirection: "row", alignItems: "center", marginTop: 8, gap: 4 },
  qualityLine: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 8, flexWrap: "wrap" },
  qualityBadge: { color: "#92400e", backgroundColor: "#fef3c7", borderColor: "#f59e0b", borderWidth: 1, overflow: "hidden", paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, fontWeight: "900" },
  party: { fontSize: 18, color: "#0f172a", fontWeight: "900", marginTop: 8 },
  meta: { color: "#475569", fontWeight: "600", marginTop: 5 },
  metaStrong: { color: "#0f172a", fontWeight: "900", marginTop: 8 },
  metaValue: { color: "#475569", fontWeight: "700" },
  lockNote: { color: "#166534", backgroundColor: "#dcfce7", borderRadius: 12, padding: 10, fontWeight: "900", marginTop: 10 },
  rowActions: { flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 12 },
  button: { backgroundColor: "#16a34a", borderRadius: 16, paddingVertical: 13, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  buttonDanger: { backgroundColor: "#dc2626" },
  buttonGhost: { backgroundColor: "#e0edff" },
  buttonMuted: { backgroundColor: "#64748b" },
  buttonDisabled: { opacity: 0.55 },
  buttonPressed: { transform: [{ scale: 0.98 }] },
  buttonText: { color: "#fff", fontWeight: "900", fontSize: 15 },
  buttonGhostText: { color: "#1d4ed8" },
  workSheet: { ...StyleSheet.absoluteFillObject, backgroundColor: "#eef4fb", paddingTop: 12 },
  workScroll: { paddingBottom: 210 },
  workHeader: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, marginBottom: 8 },
  sheetTitle: { fontSize: 24, fontWeight: "900", color: "#0f172a", paddingHorizontal: 0 },
  sheetSub: { color: "#475569", fontWeight: "800", paddingHorizontal: 16, marginTop: 4, marginBottom: 8 },
  selectedTotal: { color: "#1d4ed8", fontWeight: "900", fontSize: 24, paddingHorizontal: 16, marginVertical: 8 },
  colorRow: { marginHorizontal: 16, marginBottom: 12, backgroundColor: "#fff", borderRadius: 18, borderWidth: 1, borderColor: "#bfdbfe", padding: 14, gap: 10 },
  colorCompleted: { backgroundColor: "#f0fdf4", borderColor: "#bbf7d0" },
  colorTopLine: { flexDirection: "row", justifyContent: "space-between", gap: 10, flexWrap: "wrap" },
  colorBody: { borderTopWidth: 1, borderTopColor: "#e2e8f0", paddingTop: 10, gap: 8 },
  colorInfo: { gap: 7 },
  colorNo: { color: "#1d4ed8", fontSize: 48, lineHeight: 54, fontWeight: "900" },
  completedBadge: { color: "#166534", backgroundColor: "#dcfce7", overflow: "hidden", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, fontWeight: "900", alignSelf: "flex-start" },
  takenText: { color: "#475569", fontWeight: "800", fontSize: 15 },
  qtyChoiceRow: { flexDirection: "row", gap: 10 },
  choiceBox: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderColor: "#dbeafe", borderRadius: 14, padding: 14, backgroundColor: "#fff" },
  fakeCheck: { width: 24, height: 24, borderRadius: 4, borderWidth: 1.5, borderColor: "#64748b", backgroundColor: "#fff" },
  fakeCheckOn: { backgroundColor: "#1d4ed8", borderColor: "#1d4ed8" },
  choiceText: { fontWeight: "900", color: "#1f2937", fontSize: 16 },
  qtyInput: { borderWidth: 1, borderColor: "#bfdbfe", borderRadius: 14, padding: 14, color: "#0f172a", fontSize: 24, fontWeight: "900", backgroundColor: "#fff" },
  baleHistory: { padding: 16, paddingBottom: 140 },
  baleCard: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#bfdbfe", borderRadius: 16, padding: 12, marginTop: 10, gap: 8 },
  balePhoto: { width: "100%", height: 170, borderRadius: 14, marginTop: 4, borderWidth: 1, borderColor: "#bfdbfe" },
  photoNote: { marginTop: 4, color: "#64748b", fontWeight: "800", backgroundColor: "#f8fafc", borderRadius: 12, padding: 10 },
  fixedActions: { position: "absolute", left: 12, right: 12, bottom: 12, backgroundColor: "#fff", borderRadius: 22, padding: 12, gap: 8, shadowColor: "#0f172a", shadowOpacity: 0.18, shadowRadius: 18, elevation: 10 },
  floatingTotals: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10, paddingBottom: 2 },
  floatingLabel: { color: "#475569", fontWeight: "900", fontSize: 15 },
  floatingTotalNo: { color: "#1d4ed8", fontSize: 26, fontWeight: "900" },
  footerActions: { position: "absolute", left: 16, right: 16, bottom: 12 }
});


