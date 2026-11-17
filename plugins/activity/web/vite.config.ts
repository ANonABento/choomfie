import { defineConfig } from "vite";

const bus = `http://localhost:${process.env.ACTIVITY_BUS_PORT ?? "3001"}`;

export default defineConfig({
  root: import.meta.dirname,
  envDir: import.meta.dirname,
  server: {
    proxy: {
      "/api": bus,
      "/bus": { target: bus, ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
