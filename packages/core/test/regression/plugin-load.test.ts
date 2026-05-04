/**
 * Regression test — verifies all plugins load and have correct interface.
 */
import { test, expect, describe } from "bun:test";

const PLUGIN_NAMES = ["voice", "browser", "tutor", "socials"];

describe("plugin interface", () => {
  for (const name of PLUGIN_NAMES) {
    test(`${name} plugin exports valid Plugin interface`, async () => {
      const mod = await import(`@choomfie/${name}`);
      const plugin = mod.default;

      // Required: name
      expect(plugin.name).toBe(name);

      // Required: tools array
      expect(Array.isArray(plugin.tools)).toBe(true);
      expect(plugin.tools.length).toBeGreaterThan(0);

      // Each tool has definition with name, description, inputSchema
      for (const tool of plugin.tools) {
        expect(typeof tool.definition.name).toBe("string");
        expect(typeof tool.definition.description).toBe("string");
        expect(tool.definition.inputSchema).toBeTruthy();
        expect(typeof tool.handler).toBe("function");
      }

      // Optional fields are correct types if present
      if (plugin.instructions) {
        expect(Array.isArray(plugin.instructions)).toBe(true);
      }
      if (plugin.intents) {
        expect(Array.isArray(plugin.intents)).toBe(true);
      }
      if (plugin.init) {
        expect(typeof plugin.init).toBe("function");
      }
      if (plugin.destroy) {
        expect(typeof plugin.destroy).toBe("function");
      }
      if (plugin.userTools) {
        expect(Array.isArray(plugin.userTools)).toBe(true);
      }
    });
  }
});
