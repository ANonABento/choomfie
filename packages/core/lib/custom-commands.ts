import {
  SlashCommandBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

export const CUSTOM_COMMAND_NAME_RE = /^[a-z0-9_-]{1,32}$/;

export interface CustomCommandDefinition {
  name: string;
}

export function isValidCustomCommandName(name: string): boolean {
  return CUSTOM_COMMAND_NAME_RE.test(name);
}

export function normalizeCustomCommandName(name: string): string {
  return name.trim().toLowerCase();
}

export function buildCustomCommandDefs(
  customCommands: CustomCommandDefinition[]
): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return customCommands
    .map((command) => normalizeCustomCommandName(command.name))
    .filter((name) => isValidCustomCommandName(name))
    .map((name) =>
      new SlashCommandBuilder()
        .setName(name)
        .setDescription("Custom command")
        .toJSON()
    );
}

export function mergeCommandDefs(
  staticCommands: RESTPostAPIChatInputApplicationCommandsJSONBody[],
  customCommands: CustomCommandDefinition[]
): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const staticNames = new Set(staticCommands.map((command) => command.name));
  const dynamicNames = new Set<string>();
  const dynamicCommands = customCommands
    .map((command) => normalizeCustomCommandName(command.name))
    .filter((name) => isValidCustomCommandName(name))
    .filter((name) => !staticNames.has(name))
    .filter((name) => {
      if (dynamicNames.has(name)) return false;
      dynamicNames.add(name);
      return true;
    })
    .map((name) => ({ name }));
  const dynamic = buildCustomCommandDefs(dynamicCommands);
  return [...staticCommands, ...dynamic];
}
