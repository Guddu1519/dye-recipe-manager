import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

const SALES_PUSH_API = "https://mtmdyeing.onrender.com/api/send-sales-push";

function clean(value) {
  return String(value || "").trim();
}

function normalize(value) {
  return clean(value).toLowerCase();
}

function getProjectId() {
  return Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId || "";
}

export async function registerPushToken(supabase, { role, appName, profile, session }) {
  try {
    if (Platform.OS === "web") return null;
    const userEmail = normalize(profile?.login_email || session?.user?.email);
    if (!userEmail) return null;
    const permission = await Notifications.getPermissionsAsync();
    let status = permission.status;
    if (status !== "granted") {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== "granted") return null;
    const projectId = getProjectId();
    const tokenResult = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    const expoPushToken = tokenResult?.data;
    if (!expoPushToken) return null;
    const { error } = await supabase.from("sales_push_tokens").upsert({
      user_email: userEmail,
      role,
      app_name: appName,
      expo_push_token: expoPushToken,
      device_label: `${Platform.OS} ${Constants.deviceName || ""}`.trim(),
      active: true,
      updated_at: new Date().toISOString()
    }, { onConflict: "expo_push_token" });
    if (error) console.warn("Push token save skipped:", error.message);
    return expoPushToken;
  } catch (error) {
    console.warn("Push token registration skipped:", error.message);
    return null;
  }
}

export async function sendPushToUsers(supabase, { role, emails = [], title, body, data = {} }) {
  try {
    const serverResponse = await fetch(SALES_PUSH_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, emails, title, body, data })
    });
    if (serverResponse.ok) return;
    console.warn("Push server failed, trying Supabase fallback:", await serverResponse.text());

    const cleanEmails = emails.map(normalize).filter(Boolean);
    let query = supabase.from("sales_push_tokens").select("expo_push_token,user_email").eq("active", true);
    if (role) query = query.eq("role", role);
    const { data: rows, error } = await query;
    if (error) {
      console.warn("Push token load skipped:", error.message);
      return;
    }
    const tokens = (rows || [])
      .filter((row) => !cleanEmails.length || cleanEmails.includes(normalize(row.user_email)))
      .map((row) => row.expo_push_token)
      .filter(Boolean);
    if (!tokens.length) return;
    const messages = tokens.map((to) => ({
      to,
      sound: "default",
      title,
      body,
      data
    }));
    for (let i = 0; i < messages.length; i += 100) {
      await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(messages.slice(i, i + 100))
      });
    }
  } catch (error) {
    console.warn("Push send skipped:", error.message);
  }
}
