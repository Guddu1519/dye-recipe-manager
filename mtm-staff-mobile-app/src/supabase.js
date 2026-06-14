import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import Constants from "expo-constants";

const extra = Constants.expoConfig?.extra || {};

function cleanConfigValue(value) {
  let text = String(value || "").trim();
  if (!text || text.startsWith("$")) return "";
  return text;
}

const supabaseUrl =
  cleanConfigValue(process.env.EXPO_PUBLIC_SUPABASE_URL) ||
  cleanConfigValue(extra.supabaseUrl) ||
  "https://dgxrkymrestwrcwgntdu.supabase.co";

const supabaseAnonKey =
  cleanConfigValue(process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY) ||
  cleanConfigValue(extra.supabaseAnonKey) ||
  "sb_publishable__nucZ26XMvkLyBCn7hf5Sw_JgIQIGil";

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false
  },
  realtime: {
    params: {
      eventsPerSecond: 10
    }
  }
});
