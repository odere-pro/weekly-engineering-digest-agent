// digest.config.json and .env schemas. Frozen: defaults and thresholds are tuned on main.
import { z } from 'zod';
import { RoleSchema } from '../models/roles';
import { SourceSchema } from '../domain/schemas';
import { isReservedSourceId } from '../store/layout';

export const ProfileNameSchema = z.enum(['quality', 'fast', 'light']);
export type ProfileName = z.infer<typeof ProfileNameSchema>;

const GuardModeSchema = z.enum(['any', 'all']);
export type GuardMode = z.infer<typeof GuardModeSchema>;

export const InputGuardsSchema = z.object({
  enabled: z.boolean().default(true),
  /** any: block on the first flag. all: block only when every enabled guard flags. */
  mode: GuardModeSchema.default('any'),
  checks: z
    .object({
      /** Deterministic injection patterns, no model call; runs first (W11-04). */
      ruleInjection: z.boolean().default(true),
      clefPolicy: z.boolean().default(true),
      graniteRisk: z.boolean().default(true),
    })
    .prefault({}),
});

export const OutputGuardsSchema = z.object({
  enabled: z.boolean().default(true),
  mode: GuardModeSchema.default('any'),
  checks: z
    .object({
      graniteGroundedness: z.boolean().default(true),
      clefRubric: z.boolean().default(true),
    })
    .prefault({}),
});

export const GuardsConfigSchema = z.object({
  input: InputGuardsSchema.prefault({}),
  output: OutputGuardsSchema.prefault({}),
});
export type GuardsConfig = z.infer<typeof GuardsConfigSchema>;

export const ThresholdsSchema = z.object({
  /** Items below this expected relevance (0-3) are dropped. */
  minRelevance: z.number().min(0).max(3).default(1.5),
  /** Items with hype probability above this are dropped. */
  maxHype: z.number().min(0).max(1).default(0.6),
  /** Items with minor-release probability above this are dropped. */
  maxMinorRelease: z.number().min(0).max(1).default(0.75),
  /** A decision-model guard flags when P(yes) is above this. */
  guardFlag: z.number().min(0).max(1).default(0.35),
});
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export const EmailDeliverySchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  /** Refuse to send credentials unless the server upgrades to TLS (STARTTLS). Off only for local mail catchers. */
  requireTLS: z.boolean().default(true),
  user: z.string().min(1),
  from: z.email(),
  to: z.array(z.email()).min(1),
});

const DeliveryConfigSchema = z.object({
  /**
   * Always on: the digest is written as <weekId>.md and .html, into `dir` when set, else into the
   * week's digest folder (`<dataDir>/<monday>/digest/`).
   */
  markdown: z.object({ dir: z.string().min(1).optional() }).prefault({}),
  email: EmailDeliverySchema.optional(),
  /** The webhook URL lives in .env (SLACK_WEBHOOK_URL). */
  slack: z.object({ enabled: z.boolean().default(false) }).optional(),
});

const ModelOverridesSchema = z.object({
  /** Replace the profile's writer panel. One entry turns the panel off. */
  writers: z
    .array(z.string().min(1))
    .min(1)
    .refine(
      (w) => new Set(w).size === w.length,
      'writers must be unique: outcomes and scores are keyed by tag',
    )
    .optional(),
  /** Per-role timeout in ms. */
  timeoutsMs: z.partialRecord(RoleSchema, z.number().int().min(1000)).optional(),
  retries: z.number().int().min(0).max(5).default(2),
  /**
   * Thinking per role for models that support it (Ollama `think`). Unset roles use the adapter
   * default: guardRisk off, others the model's own default.
   */
  think: z
    .partialRecord(RoleSchema, z.union([z.boolean(), z.enum(['low', 'medium', 'high'])]))
    .optional(),
  /**
   * Score the items that pass the decider's filter once more with the writer model (W6-08).
   * Off by default: W6-08 measured it worse on light (recall 1.50 to 0.83, +2 min a week). Wired
   * in runs and in `digest eval`.
   */
  rescoreWithWriter: z.boolean().default(false),
  /** Sampling seed sent with every generate call, so a rerun of a week repeats itself (W7-03). */
  seed: z.number().int().min(0).default(42),
  /**
   * Sampling temperature per role. Unset roles use the adapter default (W7-03): write 0.2,
   * every other role 0.
   */
  temperature: z.partialRecord(RoleSchema, z.number().min(0).max(2)).optional(),
});

const ScheduleSchema = z.object({
  /** Default: Mondays 07:45. */
  cron: z.string().min(1).default('45 7 * * 1'),
  timeZone: z
    .string()
    .min(1)
    .default(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
});

/**
 * A source URL with `user:pass@` would carry the secret into errors, logs and run records (real
 * `fetch` echoes the whole URL when it refuses one). The message names no value.
 */
const CredentialFreeSourceSchema = SourceSchema.refine(
  ({ url }) => {
    if (!URL.canParse(url)) return true; // `z.url()` has already reported it
    const { username, password } = new URL(url);
    return username === '' && password === '';
  },
  {
    message: 'the URL must not contain a username or password; keep secrets in .env',
    path: ['url'],
  },
).refine(({ id }) => !isReservedSourceId(id), {
  // A source's raw and formatted data share the day folder with the week's digest folder.
  message: 'the id "digest" is reserved for the digest folder; choose another',
  path: ['id'],
});

export const ConfigSchema = z
  .object({
    profile: ProfileNameSchema.default('quality'),
    /** Max 25: the classifier asks a choice over these plus "other" (decision models allow 26 options). */
    focusAreas: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(25)
      .refine(
        (a) => new Set(a.map((x) => x.toLowerCase())).size === a.length,
        'focus areas must be unique',
      ),
    sources: z
      .array(CredentialFreeSourceSchema)
      .min(1)
      .refine((s) => new Set(s.map((x) => x.id)).size === s.length, 'source ids must be unique'),
    windowDays: z.number().int().min(1).max(31).default(7),
    maxItemsPerSource: z.number().int().min(1).max(100).default(20),
    /** Items in the digest: 3-5. */
    topN: z.number().int().min(3).max(5).default(5),
    /** Weeks of sent URLs removed from new digests. */
    dedupeWeeks: z.number().int().min(0).max(12).default(4),
    /** Weeks older than this are pruned (digest.md kept), with the fetched data and logs of their days. */
    keepWeeks: z.number().int().min(1).default(12),
    /** Where everything the project produces goes: runs, fetched data, logs (`store/layout.ts`). */
    dataDir: z.string().min(1).default('dist'),
    schedule: ScheduleSchema.prefault({}),
    delivery: DeliveryConfigSchema.prefault({}),
    guards: GuardsConfigSchema.prefault({}),
    thresholds: ThresholdsSchema.prefault({}),
    models: ModelOverridesSchema.prefault({}),
  })
  .refine((config) => config.keepWeeks >= config.dedupeWeeks, {
    message: 'keepWeeks must be at least dedupeWeeks: pruned weeks drop out of cross-week dedupe',
    path: ['keepWeeks'],
  });
export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;

/** Secrets: .env only, never logged, never written to run records or traces. */
export const SecretsSchema = z.object({
  SMTP_PASSWORD: z.string().min(1).optional(),
  /** https only: the secret path in the URL must not travel in clear text. */
  SLACK_WEBHOOK_URL: z.url({ protocol: /^https$/ }).optional(),
  GITHUB_TOKEN: z.string().min(1).optional(),
});
export type Secrets = z.infer<typeof SecretsSchema>;

export const SECRET_KEYS = Object.keys(SecretsSchema.shape) as (keyof Secrets)[];

/**
 * http(s) only. A bare `localhost:11434` parses as a URL whose scheme is `localhost:`, and
 * `ftp://x` is one too; both would fail later as a misleading "unknown scheme" error.
 */
const httpUrl = () =>
  z.url({
    protocol: /^https?$/,
    error: 'must be a URL that starts with http:// or https://',
  });

/** Non-secret environment settings. */
export const EnvSchema = z.object({
  OLLAMA_URL: httpUrl().default('http://localhost:11434'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Set to enable OpenTelemetry traces (e.g. http://localhost:4318/v1/traces). */
  OTEL_EXPORTER_OTLP_ENDPOINT: httpUrl().optional(),
  /**
   * The OS and CPU of the machine Ollama runs on, when it differs from this process (the app in
   * a Linux container, Ollama on a Mac host). Values as `uname -s` / `uname -m` or Node's
   * `process.platform` / `process.arch`; `make docker-*` exports them.
   */
  DIGEST_HOST_OS: z.string().min(1).optional(),
  DIGEST_HOST_ARCH: z.string().min(1).optional(),
  /** Model tag `digest eval` uses to score the winning digests (reported, not gated); unset means no judge scores. */
  EVAL_JUDGE: z.string().min(1).optional(),
});
export type Env = z.infer<typeof EnvSchema>;
