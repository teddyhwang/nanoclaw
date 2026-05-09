/**
 * Built-in help command. Introspects the resource and command registries.
 *
 *   ncl help               — list all resources and commands
 *   ncl groups help         — show group resource details (verbs, columns, enums)
 */
import { getResource, getResources } from '../crud.js';
import { listCommands, register } from '../registry.js';

register({
  name: 'help',
  description: 'List available resources and commands.',
  access: 'open',
  parseArgs: () => ({}),
  handler: async () => {
    const resources = getResources();
    const commands = listCommands().filter((c) => c.access !== 'hidden' && !c.resource);

    const lines: string[] = [];
    if (resources.length > 0) {
      lines.push('Resources:');
      for (const r of resources) {
        const ops: string[] = [];
        if (r.operations.list) ops.push('list');
        if (r.operations.get) ops.push('get');
        if (r.operations.create) ops.push('create');
        if (r.operations.update) ops.push('update');
        if (r.operations.delete) ops.push('delete');
        if (r.customOperations) ops.push(...Object.keys(r.customOperations));
        lines.push(`  ${r.plural.padEnd(20)} ${r.description}`);
        lines.push(`  ${''.padEnd(20)} verbs: ${ops.join(', ')}`);
      }
    }

    if (commands.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('Commands:');
      for (const c of commands) {
        lines.push(`  ${c.name.padEnd(20)} ${c.description}`);
      }
    }

    lines.push('');
    lines.push('Run `ncl <resource> help` for detailed field information.');
    return lines.join('\n');
  },
});

// Register per-resource help commands. These are registered dynamically
// after the resources barrel has been imported.
// We use a lazy approach: register a catch-all pattern isn't possible with
// the flat registry, so we register `<plural>-help` for each resource
// in a post-import hook.
export function registerResourceHelpCommands(): void {
  for (const res of getResources()) {
    // Skip if already registered (e.g. from a previous call)
    try {
      register({
        name: `${res.plural}-help`,
        description: `Show ${res.name} resource details.`,
        access: 'open',
        resource: res.plural,
        parseArgs: () => ({}),
        handler: async () => {
          const lines: string[] = [];
          lines.push(`${res.plural}: ${res.description}`);
          lines.push('');

          // Verbs
          const verbs: string[] = [];
          if (res.operations.list) verbs.push(`list [open]`);
          if (res.operations.get) verbs.push(`get <id> [open]`);
          if (res.operations.create) verbs.push(`create [approval]`);
          if (res.operations.update) verbs.push(`update <id> [approval]`);
          if (res.operations.delete) verbs.push(`delete <id> [approval]`);
          if (res.customOperations) {
            for (const [verb, op] of Object.entries(res.customOperations)) {
              verbs.push(`${verb} [${op.access}] — ${op.description}`);
            }
          }
          lines.push('Verbs:');
          for (const v of verbs) lines.push(`  ${v}`);
          lines.push('');

          // Columns
          lines.push('Fields:');
          for (const col of res.columns) {
            const tags: string[] = [];
            if (col.generated) tags.push('auto');
            if (col.required) tags.push('required');
            if (col.updatable) tags.push('updatable');
            if (col.default !== undefined && col.default !== null) tags.push(`default: ${col.default}`);
            if (col.enum) tags.push(`values: ${col.enum.join(' | ')}`);

            const flag = `--${col.name.replace(/_/g, '-')}`;
            const tagStr = tags.length > 0 ? ` (${tags.join(', ')})` : '';
            lines.push(`  ${flag.padEnd(28)} ${col.description}${tagStr}`);
          }
          return lines.join('\n');
        },
      });
    } catch {
      // Already registered — skip
    }
  }
}
