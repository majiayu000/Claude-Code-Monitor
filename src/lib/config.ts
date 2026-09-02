/**
 * Configuration management for Keepline.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureKeeplineDataHome, getKeeplineHome } from './paths.js';
import { ConfigError } from './errors.js';

export const DEFAULT_WEB_PORT = 3377;

export type SessionDigestSummarizerProvider =
  | 'disabled'
  | 'ollama'
  | 'lm_studio'
  | 'openai_compatible_local';

export interface SessionDigestSummarizerConfig {
  /** Provider used for optional local model session digests */
  provider: SessionDigestSummarizerProvider;
  /** Loopback OpenAI-compatible base URL, for example http://127.0.0.1:11434/v1 */
  baseUrl: string;
  /** Local model name */
  model: string;
  /** Request timeout in milliseconds */
  timeoutMs: number;
  /** Max serialized session input sent to the local provider */
  maxInputChars: number;
  /** Max output tokens requested from the provider */
  maxOutputTokens: number;
}

export interface KeeplineConfig {
  /** Scan interval in milliseconds */
  scanInterval: number;

  /** Hook server port */
  hookPort: number;

  /** Web dashboard port */
  webPort: number;

  /** Log level */
  logLevel: 'debug' | 'info' | 'warn' | 'error';

  /** Enable file logging */
  fileLogging: boolean;

  /** Deprecated compatibility field; no production auto-start reader. */
  autoDaemon: boolean;

  /** Session retention days (0 = forever) */
  retentionDays: number;

  /** CPU threshold for considering a process as active (percentage) */
  activeCpuThreshold: number;

  /** Time threshold for considering a session as idle (seconds) */
  idleThresholdSeconds: number;

  /** Time threshold for considering activity as "running" vs "waiting" (seconds) */
  runningThresholdSeconds: number;

  /** Process cache TTL in milliseconds */
  processCacheTtl: number;

  /** Web transport TLS configuration (legacy object name). */
  webTerminal: {
    /** TLS certificate path */
    tlsCert: string;
    /** TLS key path */
    tlsKey: string;
  };

  /** Session digest configuration */
  sessionDigest: {
    summarizer: SessionDigestSummarizerConfig;
  };
}

const defaultConfig: KeeplineConfig = {
  scanInterval: 5000,
  hookPort: 7890,
  webPort: DEFAULT_WEB_PORT,
  logLevel: 'info',
  fileLogging: true,
  autoDaemon: false,
  retentionDays: 30,
  activeCpuThreshold: 1.0,
  idleThresholdSeconds: 30,
  runningThresholdSeconds: 5,
  processCacheTtl: 3000,
  webTerminal: {
    tlsCert: '',
    tlsKey: '',
  },
  sessionDigest: {
    summarizer: {
      provider: 'disabled',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: '',
      timeoutMs: 30000,
      maxInputChars: 12000,
      maxOutputTokens: 800,
    },
  },
};

/**
 * Environment reads are intentionally kept at process and security boundaries
 * instead of being blindly moved into persisted config. Examples include
 * storage path overrides, bind/proxy trust inputs, local auth origins, terminal
 * shell environment, and external provider credentials.
 */
export const CONFIG_ENV_BOUNDARY_EXCEPTIONS = [
  'KEEPLINE_HOME',
  'KEEPLINE_HOST',
  'KEEPLINE_PUBLIC_ORIGIN',
  'KEEPLINE_ALLOWED_ORIGINS',
  'KEEPLINE_TRUST_PROXY',
  'KEEPLINE_PROJECT_ROOTS',
  'KEEPLINE_TERMINAL_CWD_ROOTS',
  'ANTHROPIC_API_KEY',
  'CODEX_AUTH_PATH',
] as const;

/**
 * Resolve the config file path lazily so a runtime KEEPLINE_HOME override
 * set after this module imports still routes reads/writes correctly.
 */
function getConfigFile(): string {
  return join(getKeeplineHome(), 'config.json');
}

/** Validate config values are within acceptable ranges */
export function isValidPortNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** Validate config values are within acceptable ranges */
export function validateConfig(cfg: KeeplineConfig): void {
  const errors: string[] = [];

  if (cfg.scanInterval < 100) {
    errors.push('scanInterval must be at least 100ms');
  }
  if (!isValidPortNumber(cfg.hookPort)) {
    errors.push('hookPort must be between 1 and 65535');
  }
  if (!isValidPortNumber(cfg.webPort)) {
    errors.push('webPort must be between 1 and 65535');
  }
  if (!['debug', 'info', 'warn', 'error'].includes(cfg.logLevel)) {
    errors.push('logLevel must be one of: debug, info, warn, error');
  }
  if (cfg.retentionDays < 0) {
    errors.push('retentionDays must be non-negative');
  }
  if (cfg.activeCpuThreshold < 0 || cfg.activeCpuThreshold > 100) {
    errors.push('activeCpuThreshold must be between 0 and 100');
  }
  if (cfg.idleThresholdSeconds < 1) {
    errors.push('idleThresholdSeconds must be at least 1');
  }
  if (cfg.runningThresholdSeconds < 1) {
    errors.push('runningThresholdSeconds must be at least 1');
  }
  if (cfg.processCacheTtl < 100) {
    errors.push('processCacheTtl must be at least 100ms');
  }
  const summarizer = cfg.sessionDigest.summarizer;
  if (!['disabled', 'ollama', 'lm_studio', 'openai_compatible_local'].includes(
    summarizer.provider
  )) {
    errors.push(
      'sessionDigest.summarizer.provider must be one of: disabled, ollama, lm_studio, openai_compatible_local'
    );
  }
  if (!Number.isFinite(summarizer.timeoutMs) ||
    summarizer.timeoutMs < 1000 ||
    summarizer.timeoutMs > 120000) {
    errors.push('sessionDigest.summarizer.timeoutMs must be between 1000 and 120000');
  }
  if (!Number.isFinite(summarizer.maxInputChars) || summarizer.maxInputChars < 1000) {
    errors.push('sessionDigest.summarizer.maxInputChars must be at least 1000');
  }
  if (!Number.isFinite(summarizer.maxOutputTokens) || summarizer.maxOutputTokens < 1) {
    errors.push('sessionDigest.summarizer.maxOutputTokens must be positive');
  }
  if (summarizer.provider !== 'disabled') {
    if (!summarizer.model.trim()) {
      errors.push('sessionDigest.summarizer.model is required when provider is enabled');
    }
    const baseUrlError = validateLoopbackUrl(summarizer.baseUrl);
    if (baseUrlError) {
      errors.push(`sessionDigest.summarizer.baseUrl ${baseUrlError}`);
    }
  }

  if (errors.length > 0) {
    throw new ConfigError(`Invalid config: ${errors.join('; ')}`);
  }
}

type PartialKeeplineConfig = Partial<Omit<KeeplineConfig, 'webTerminal' | 'sessionDigest'>> & {
  webTerminal?: Partial<KeeplineConfig['webTerminal']>;
  sessionDigest?: {
    summarizer?: Partial<SessionDigestSummarizerConfig>;
  };
};

function cloneDefaultConfig(): KeeplineConfig {
  return {
    ...defaultConfig,
    webTerminal: { ...defaultConfig.webTerminal },
    sessionDigest: {
      summarizer: { ...defaultConfig.sessionDigest.summarizer },
    },
  };
}

function mergeConfig(parsed: PartialKeeplineConfig): KeeplineConfig {
  return {
    ...defaultConfig,
    ...parsed,
    webTerminal: {
      ...defaultConfig.webTerminal,
      ...(parsed.webTerminal ?? {}),
    },
    sessionDigest: {
      summarizer: {
        ...defaultConfig.sessionDigest.summarizer,
        ...(parsed.sessionDigest?.summarizer ?? {}),
      },
    },
  };
}

function validateLoopbackUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'must be a valid URL';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'must use http or https';
  }

  const host = url.hostname.toLowerCase();
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (!loopbackHosts.has(host)) {
    return 'must be loopback';
  }

  return null;
}

class ConfigManager {
  private config: KeeplineConfig = cloneDefaultConfig();
  private loaded = false;

  load(): KeeplineConfig {
    if (this.loaded) return this.config;

    ensureKeeplineDataHome();
    const configFile = getConfigFile();

    if (existsSync(configFile)) {
      try {
        const content = readFileSync(configFile, 'utf-8');
        const parsed = JSON.parse(content) as PartialKeeplineConfig;
        this.config = mergeConfig(parsed);

        // Validate loaded config
        validateConfig(this.config);
      } catch (e) {
        if (e instanceof ConfigError) {
          throw e;
        }
        throw new ConfigError(`Failed to parse config: ${(e as Error).message}`);
      }
    } else {
      this.save();
    }

    this.loaded = true;
    return this.config;
  }

  save(): void {
    const home = getKeeplineHome();
    if (!existsSync(home)) {
      mkdirSync(home, { recursive: true });
    }
    writeFileSync(getConfigFile(), JSON.stringify(this.config, null, 2));
  }

  get(): KeeplineConfig {
    return this.load();
  }

  set<K extends keyof KeeplineConfig>(key: K, value: KeeplineConfig[K]): void {
    this.load();
    this.config[key] = value;
    this.save();
  }

  reset(): void {
    this.config = cloneDefaultConfig();
    this.save();
  }
}

export const config = new ConfigManager();
