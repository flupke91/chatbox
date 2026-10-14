import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'xyz.chatboxapp.chatbox',
  appName: 'Chatbox',
  webDir: 'release/app/dist/renderer',
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
    cleartext: true,
  },
  plugins: {
    CapacitorSQLite: {
      iosDatabaseLocation: 'Library/CapacitorDatabase',
      iosIsEncryption: false,
      iosKeychainPassword: '',
      iosBiometric: {
        biometricAuth: false,
        biometricTitle: 'Biometric login for sqlite',
      },
      androidDatabaseLocation: 'default',
    },
    Keyboard: {
      resize: 'body',
      style: 'dark',
      resizeOnFullScreen: true,
    },
    StatusBar: {
      style: 'dark',
      overlaysWebView: true,
    },
  },
}

export default config
