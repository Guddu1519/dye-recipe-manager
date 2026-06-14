# MTM Staff Mobile App

This is a separate native/mobile staff app for MTM Sales Manager.

It is not a WebView wrapper. It uses React Native + Expo and connects directly to the same Supabase cloud database used by the main MTM website.

## Current Features

- Team member login with Supabase Auth
- Persistent login until manual logout
- Blocks non-staff roles
- Loads only orders assigned to the logged-in team member email
- Realtime Supabase sync from `sales_state`
- In-app notification when a new assigned order appears
- Notification bell with unread count
- Assigned order dashboard
- Search assigned orders
- Accept / In Process status actions
- Bale creation with color number and QTY
- Bale history view

## Required Supabase Tables

The app uses the existing website tables:

- `sales_profiles`
- `sales_state`

The staff user must exist in Supabase Auth and also in `sales_profiles` with:

```sql
role = 'staff'
login_email = 'staff email'
```

## Environment Variables

Already configured in `eas.json` for this project:

```text
EXPO_PUBLIC_SUPABASE_URL
EXPO_PUBLIC_SUPABASE_ANON_KEY
```

## Install

```bash
cd mtm-staff-mobile-app
npm install
```

## Run For Testing

```bash
npm start
```

Then scan the Expo QR code with Expo Go, or run on Android emulator.

## Build APK

Install/login to EAS once:

```bash
npx eas login
```

Build APK:

```bash
npm run build:apk
```

## Build Play Store AAB Later

```bash
npm run build:aab
```

## Push Notifications Note

This first version has in-app and local notifications while the app is running. Full closed-app push notifications require storing Expo push tokens and sending push notifications from a backend when Admin assigns an order.
