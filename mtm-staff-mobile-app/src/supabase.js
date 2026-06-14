import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import Constants from "expo-constants";

const extra = Constants.expoConfig?.extra || {};

const supabaseUrl =
  process.env.EXPO_PUBLIC_SUPABASE_URL ||
  extra.supabaseUrl ||
  "https://dgxrkymrestwrcwgntdu.supabase.co";

const supabaseAnonKey =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
  extra.supabaseAnonKey ||
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
