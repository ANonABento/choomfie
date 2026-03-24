/**
 * Skills registry — loadable tool/skill modules.
 *
 * Skills are functions the agent can call. Register them here,
 * and they get injected into the agent's system prompt.
 */

export interface Skill {
  name: string;
  description: string;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

const skills = new Map<string, Skill>();

export function registerSkill(skill: Skill) {
  skills.set(skill.name, skill);
}

export function getSkill(name: string): Skill | undefined {
  return skills.get(name);
}

export function listSkills(): Skill[] {
  return Array.from(skills.values());
}

export function buildSkillsPrompt(): string {
  const all = listSkills();
  if (all.length === 0) return "";

  const lines = all.map((s) => `- ${s.name}: ${s.description}`);
  return `## Available Skills\n${lines.join("\n")}`;
}
