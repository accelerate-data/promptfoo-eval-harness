'use strict';
/**
 * probe.js — throwaway file:// provider for the Promptfoo option-shape spike.
 *
 * Purpose: capture the exact shape of (prompt, context, options) that Promptfoo
 * passes to callApi, AND what the constructor receives, so the bridge design
 * in spec §2.2/§2.6 can be validated.
 *
 * THROWAWAY — not production code. See spikes/promptfoo-file-provider-shape/README.md.
 */

const fs = require('fs');

/**
 * Safely serialize an object, replacing circular or non-plain values with
 * a description string. Captures all plain-data fields we care about.
 */
function safeStringify(obj, indent) {
  const seen = new WeakSet();
  return JSON.stringify(
    obj,
    (key, value) => {
      if (value !== null && typeof value === 'object') {
        if (seen.has(value)) {
          return '[Circular]';
        }
        // Skip non-plain objects that are not arrays or plain Objects
        const ctor = value.constructor && value.constructor.name;
        if (ctor && ctor !== 'Object' && ctor !== 'Array') {
          return `[${ctor}]`;
        }
        seen.add(value);
      }
      return value;
    },
    indent,
  );
}

/**
 * Extract only the fields that matter for the spike — avoids circular
 * structures in context while still capturing everything relevant.
 */
function extractCallApiCapture(prompt, context, options) {
  const safeContext = {
    vars: context && context.vars,
    prompt: context && context.prompt,
    test: context && context.test ? {
      description: context.test.description,
      vars: context.test.vars,
      assert: context.test.assert,
    } : undefined,
    otherKeys: context
      ? Object.keys(context).filter(k => !['vars', 'prompt', 'test'].includes(k))
      : [],
  };

  return {
    capturedAt: new Date().toISOString(),
    prompt,
    context: safeContext,
    options,
    options_config: options && options.config,
    options_keys: options ? Object.keys(options) : [],
  };
}

class ProbeProvider {
  constructor(options) {
    // Capture what Promptfoo passes to the constructor
    this._constructorOptions = options;

    const constructorCapture = {
      capturedAt: new Date().toISOString(),
      constructorOptions: options,
      constructorOptions_config: options && options.config,
      constructorOptions_keys: options ? Object.keys(options) : [],
    };
    const constructorJson = safeStringify(constructorCapture, 2);
    const outFile = `/tmp/probe-constructor-${Date.now()}.json`;
    fs.writeFileSync(outFile, constructorJson, 'utf8');
    process.stdout.write('[probe] constructor options:\n' + constructorJson.slice(0, 2048) + '\n');
    process.stdout.write('[probe] constructor capture written to: ' + outFile + '\n');
  }

  id() {
    return 'probe-provider';
  }

  async callApi(prompt, context, options) {
    const capture = extractCallApiCapture(prompt, context, options);
    const json = safeStringify(capture, 2);

    const outFile = `/tmp/probe-call-${Date.now()}.json`;
    fs.writeFileSync(outFile, json, 'utf8');

    // Print truncated version to stdout (max ~4 KB) for CI visibility
    const truncated = json.length > 4096 ? json.slice(0, 4096) + '\n... [truncated]' : json;
    process.stdout.write('[probe] captured callApi args:\n' + truncated + '\n');
    process.stdout.write('[probe] full capture written to: ' + outFile + '\n');

    // Return a canned response — no real LLM call
    return {
      output: 'probe-ok',
      metadata: {
        captured_file: outFile,
        callApi_options_keys: options ? Object.keys(options) : [],
        callApi_options_config_present: !!(options && options.config),
        constructor_options_config_present: !!(this._constructorOptions && this._constructorOptions.config),
        constructor_config_keys: this._constructorOptions && this._constructorOptions.config
          ? Object.keys(this._constructorOptions.config)
          : [],
        context_vars_keys: context && context.vars ? Object.keys(context.vars) : [],
      },
    };
  }
}

module.exports = ProbeProvider;
