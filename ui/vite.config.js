import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// One origin for the browser in both modes, so no CORS configuration exists
// anywhere: `vite` (dev, :5173) and `vite preview` (the demo build, :3000)
// both proxy /api and the STOMP endpoint /ws to the API.
const proxy = {
  '/api': 'http://127.0.0.1:8080',
  '/ws': { target: 'ws://127.0.0.1:8080', ws: true },
};

export default defineConfig({
  plugins: [react()],
  // Bound to IPv4 loopback explicitly: Node otherwise resolves "localhost" to
  // ::1 only, and start-native.ps1's port check (and some browsers) use 127.0.0.1.
  server: { host: '127.0.0.1', port: 5173, proxy },
  preview: { host: '127.0.0.1', port: 3000, strictPort: true, proxy },
});
