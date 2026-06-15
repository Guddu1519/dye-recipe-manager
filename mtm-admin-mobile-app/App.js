import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import Constants from "expo-constants";
import * as ScreenCapture from "expo-screen-capture";
import { StatusBar } from "expo-status-bar";
import { WebView } from "react-native-webview";

const ADMIN_URL = Constants.expoConfig?.extra?.adminUrl || "https://mtmdyeing.onrender.com/";

export default function App() {
  const webViewRef = useRef(null);
  const canGoBackRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    ScreenCapture.preventScreenCaptureAsync().catch(() => {});
    return () => {
      ScreenCapture.allowScreenCaptureAsync().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (canGoBackRef.current) {
        webViewRef.current?.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, []);

  const reload = () => {
    setError("");
    setLoading(true);
    webViewRef.current?.reload();
  };

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <Text style={styles.title}>MTM</Text>
        <Pressable style={styles.reloadButton} onPress={reload}>
          <Text style={styles.reloadText}>Refresh</Text>
        </Pressable>
      </View>
      <View style={styles.webWrap}>
        <WebView
          ref={webViewRef}
          source={{ uri: ADMIN_URL }}
          style={styles.web}
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          setSupportMultipleWindows={false}
          allowsBackForwardNavigationGestures
          originWhitelist={["https://*", "http://*"]}
          onLoadStart={() => {
            setLoading(true);
            setError("");
          }}
          onLoadEnd={() => setLoading(false)}
          onNavigationStateChange={(navState) => {
            canGoBackRef.current = navState.canGoBack;
          }}
          onError={(event) => {
            setLoading(false);
            setError(event.nativeEvent.description || "Website failed to load.");
          }}
          onHttpError={(event) => {
            setLoading(false);
            setError(`Server error: ${event.nativeEvent.statusCode}`);
          }}
        />
        {loading && (
          <View style={styles.overlay}>
            <ActivityIndicator size="large" color="#1d4ed8" />
            <Text style={styles.overlayText}>Loading MTM...</Text>
          </View>
        )}
        {!!error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorTitle}>Unable to Load</Text>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable style={styles.tryButton} onPress={reload}>
              <Text style={styles.tryText}>Try Again</Text>
            </Pressable>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#eff6ff" },
  header: {
    height: 52,
    backgroundColor: "#ffffff",
    borderBottomWidth: 1,
    borderBottomColor: "#dbeafe",
    paddingHorizontal: 14,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  title: { color: "#0f172a", fontSize: 22, fontWeight: "900" },
  reloadButton: { backgroundColor: "#1d4ed8", paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999 },
  reloadText: { color: "#ffffff", fontWeight: "900" },
  webWrap: { flex: 1, backgroundColor: "#ffffff" },
  web: { flex: 1, backgroundColor: "#ffffff" },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(239,246,255,0.92)"
  },
  overlayText: { marginTop: 12, color: "#475569", fontWeight: "800" },
  errorBox: {
    position: "absolute",
    left: 18,
    right: 18,
    top: "30%",
    backgroundColor: "#ffffff",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#fecaca",
    padding: 18,
    shadowColor: "#0f172a",
    shadowOpacity: 0.16,
    shadowRadius: 24,
    elevation: 6
  },
  errorTitle: { color: "#991b1b", fontSize: 22, fontWeight: "900", marginBottom: 8 },
  errorText: { color: "#334155", fontSize: 15, lineHeight: 22 },
  tryButton: { marginTop: 16, backgroundColor: "#16a34a", borderRadius: 14, alignItems: "center", padding: 13 },
  tryText: { color: "#ffffff", fontWeight: "900", fontSize: 16 }
});
