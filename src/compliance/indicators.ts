import { z } from 'zod';
import { LIMITS } from '../limits.js';
import { isTestOrExample } from '../analysis/secrets.js';
import type { ScannedFile } from '../analysis/types.js';
import type { Dependency } from '../deps/model.js';

/**
 * Technical indicators for later regulatory packs: personal-data handling (privacy) and AI/ML components.
 * They are FACTS about what the repository contains (an analytics SDK, a model weights file), never conclusions about
 * lawfulness. Detection is static and line-bounded; absence is only meaningful when the scan was broad enough.
 */
export const PRIVACY_CATEGORIES = [
  'email',
  'ip_address',
  'location',
  'device_identifier',
  'cookies',
  'analytics',
  'telemetry',
  'credentials',
  'camera',
  'microphone',
  'contacts',
  'user_files',
] as const;
export type PrivacyCategory = (typeof PRIVACY_CATEGORIES)[number];

export const AI_CATEGORIES = [
  'ml_framework',
  'llm_client',
  'model_weights',
  'training',
  'fine_tuning',
  'inference',
  'agent',
  'dataset',
] as const;
export type AiCategory = (typeof AI_CATEGORIES)[number];

export const TechnicalIndicatorSchema = z.object({
  id: z.string(),
  family: z.enum(['privacy', 'ai']),
  category: z.string(),
  mode: z.enum(['DIRECT', 'INFERRED', 'POSSIBLE']),
  confidence: z.number().min(0).max(1),
  source: z.enum(['code', 'dependency', 'path']),
  file: z.string().optional(),
  line: z.number().optional(),
  detail: z.string().optional(),
});
export type TechnicalIndicator = z.infer<typeof TechnicalIndicatorSchema>;

interface Pattern {
  family: 'privacy' | 'ai';
  category: string;
  confidence: number;
  mode: 'DIRECT' | 'INFERRED';
  pattern: RegExp;
}

const P = (
  family: Pattern['family'],
  category: string,
  confidence: number,
  pattern: RegExp,
  mode: Pattern['mode'] = 'DIRECT',
): Pattern => ({ family, category, confidence, mode, pattern });

const CODE_PATTERNS: Pattern[] = [
  P(
    'privacy',
    'location',
    0.85,
    /\bnavigator\.geolocation\b|\bCLLocationManager\b|ACCESS_(?:FINE|COARSE)_LOCATION|\bgetCurrentPosition\s*\(|\bFusedLocationProvider/,
  ),
  P(
    'privacy',
    'camera',
    0.85,
    /\bgetUserMedia\s*\(\s*\{[^}]{0,200}video|\bAVCaptureDevice\b|android\.permission\.CAMERA|\bcv2\.VideoCapture\b|\bImageCapture\b/,
  ),
  P(
    'privacy',
    'microphone',
    0.85,
    /\bgetUserMedia\s*\(\s*\{[^}]{0,200}audio|android\.permission\.RECORD_AUDIO|\bAVAudioRecorder\b|\bMediaRecorder\b|\bsounddevice\b|\bpyaudio\b/i,
  ),
  P(
    'privacy',
    'contacts',
    0.85,
    /\bContactsContract\b|\bCNContactStore\b|\bnavigator\.contacts\b|android\.permission\.READ_CONTACTS/,
  ),
  P(
    'privacy',
    'cookies',
    0.8,
    /\bdocument\.cookie\b|\bSet-Cookie\b|\bres\.cookie\s*\(|\bcookies\.set\s*\(|\bhttp\.Cookie\s*\{|\bset_cookie\s*\(/,
  ),
  P(
    'privacy',
    'ip_address',
    0.75,
    /\breq(?:uest)?\.(?:ip|ips|remote_addr|connection\.remoteAddress)\b|\bX-Forwarded-For\b|\bRemoteAddr\b|\bgetRemoteAddr\s*\(|\bREMOTE_ADDR\b/,
  ),
  P(
    'privacy',
    'device_identifier',
    0.8,
    /\bANDROID_ID\b|\bidentifierForVendor\b|\badvertisingIdentifier\b|\bIDFA\b|\bgetDeviceId\s*\(|\bnode-machine-id\b|\bmachine-?id\b/,
  ),
  P(
    'privacy',
    'email',
    0.7,
    /\bnodemailer\b|\bsmtplib\b|\bsendgrid\b|\bmailgun\b|\bSMTP_(?:HOST|USER)\b|\bnet\/smtp\b|\bJavaMailSender\b/i,
    'INFERRED',
  ),
  P(
    'privacy',
    'analytics',
    0.8,
    /\bgtag\s*\(|\bga\s*\(\s*['"]send|\banalytics\.(?:track|identify|page)\s*\(|\bmixpanel\.track\b|\bposthog\.capture\b|\bamplitude\.(?:getInstance|track)\b|\bgoogle-analytics\b|\bplausible\b/,
  ),
  P(
    'privacy',
    'telemetry',
    0.75,
    /\bSentry\.init\s*\(|\bsentry_sdk\.init\s*\(|\bDO_NOT_TRACK\b|\btelemetry\b[^\n]{0,60}(?:send|report|enable|upload)|\bopentelemetry-exporter\b|\bsegment\.io\b/i,
    'INFERRED',
  ),
  P(
    'privacy',
    'user_files',
    0.65,
    /<input[^>]{0,80}type\s*=\s*["']file["']|\bmultipart\/form-data\b|\bFileReader\b|\bUploadFile\b|\bmulter\b/,
    'INFERRED',
  ),
  P(
    'ai',
    'training',
    0.75,
    /\b(?:trainer|Trainer)\.train\s*\(|\bmodel\.fit\s*\(|\boptimizer\.step\s*\(|\bloss\.backward\s*\(|\bSFTTrainer\b/,
  ),
  P(
    'ai',
    'fine_tuning',
    0.8,
    /\bfine[_-]?tun(?:e|ing)\b|\bLoraConfig\b|\bget_peft_model\b|\bPeftModel\b|\bQLoRA\b/i,
  ),
  P(
    'ai',
    'inference',
    0.7,
    /\bmodel\.(?:predict|generate)\s*\(|\bInferenceSession\s*\(|\bpipeline\s*\(\s*['"][\w-]+['"]|\btorch\.no_grad\s*\(|\bAutoModelFor\w+\.from_pretrained\b/,
    'INFERRED',
  ),
  P(
    'ai',
    'agent',
    0.7,
    /\bAgentExecutor\b|\btool_calls?\b|\bfunction_call\b|@modelcontextprotocol|\bcreate_react_agent\b|\bTool\s*\(\s*name\s*=/,
    'INFERRED',
  ),
  P(
    'ai',
    'dataset',
    0.7,
    /\bload_dataset\s*\(|\btorchvision\.datasets\b|\btf\.data\.Dataset\b|\bfrom datasets import\b/,
    'INFERRED',
  ),
];

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|rb|php|cs|html|vue|svelte)$/i;

const AI_DEPENDENCIES: { re: RegExp; category: AiCategory; label: string }[] = [
  {
    re: /^(?:torch|pytorch|tensorflow|tensorflow-gpu|keras|jax|jaxlib|flax|paddlepaddle|mxnet|onnx|onnxruntime|onnxruntime-gpu|tflite-runtime|scikit-learn|sklearn|xgboost|lightgbm|catboost|transformers|diffusers|peft|accelerate|bitsandbytes|sentence-transformers|spacy|nltk|gensim|huggingface[-_]hub|vllm|llama[-_.]cpp[-_]python|ctransformers|@tensorflow\/tfjs[\w-]*|onnxruntime-node|@xenova\/transformers|@huggingface\/transformers|brain\.js|ml5)$/i,
    category: 'ml_framework',
    label: 'ML framework',
  },
  {
    re: /^(?:openai|anthropic|@anthropic-ai\/sdk|google-generativeai|@google\/generative-ai|cohere|cohere-ai|mistralai|@mistralai\/mistralai|groq|langchain[\w-]*|@langchain\/[\w-]+|llama[-_]index[\w-]*|llamaindex|litellm|ollama|together|replicate|ai|@ai-sdk\/[\w-]+|semantic-kernel|guidance|dspy|dspy-ai|autogen|crewai|haystack-ai|instructor)$/i,
    category: 'llm_client',
    label: 'LLM client/orchestration',
  },
];

const WEIGHT_PATH =
  /\.(?:safetensors|gguf|ggml|onnx|pt|pth|ckpt|h5|pb|tflite|mlmodel|mlpackage|npz|joblib|bin)$/i;
const WEIGHT_STRICT = /\.(?:safetensors|gguf|ggml|onnx|pt|pth|ckpt|tflite|mlmodel)$/i;

export interface IndicatorInput {
  files: ScannedFile[];
  treePaths: string[];
  dependencies: Dependency[];
}

export function detectIndicators(input: IndicatorInput): TechnicalIndicator[] {
  const out: TechnicalIndicator[] = [];
  const seen = new Set<string>();
  const MAX = 300;
  let n = 0;
  const push = (i: Omit<TechnicalIndicator, 'id'>, key: string): void => {
    if (out.length >= MAX || seen.has(key)) return;
    seen.add(key);
    out.push({ id: `IND-${String(++n).padStart(3, '0')}`, ...i });
  };

  for (const f of input.files) {
    if (
      !SOURCE_EXT.test(f.path) ||
      isTestOrExample(f.path) ||
      /(?:^|\/)(?:node_modules|vendor|dist|build)\//.test(f.path)
    )
      continue;
    const lines = f.content.split('\n', LIMITS.maxLinesPerFile);
    const perCat = new Map<string, number>();
    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] as string).slice(0, LIMITS.maxLineChars);
      if (/^\s*(?:\/\/|#|\*|\/\*)/.test(line)) continue; // comments are not behaviour
      for (const p of CODE_PATTERNS) {
        if ((perCat.get(p.category) ?? 0) >= 2) continue;
        if (!p.pattern.test(line)) continue;
        perCat.set(p.category, (perCat.get(p.category) ?? 0) + 1);
        push(
          {
            family: p.family,
            category: p.category,
            mode: p.mode,
            confidence: p.confidence,
            source: 'code',
            file: f.path,
            line: i + 1,
          },
          `${p.category}|${f.path}|${i}`,
        );
      }
    }
  }

  // Dependencies: SDKs that collect or send data, and ML/LLM libraries.
  const ANALYTICS_DEP =
    /^(?:react-ga[\w-]*|ga-gtag|@analytics\/[\w-]+|analytics|mixpanel[\w-]*|posthog[\w-]*|amplitude[\w-]*|@amplitude\/[\w-]+|segment[\w-]*|@segment\/[\w-]+|plausible[\w-]*|@datadog\/browser-rum|firebase-analytics|@react-native-firebase\/analytics|heap-api|hotjar[\w-]*|fullstory[\w-]*|@fullstory\/[\w-]+)$/i;
  const TELEMETRY_DEP =
    /^(?:@sentry\/[\w-]+|sentry-sdk|raven|rollbar|bugsnag[\w-]*|@bugsnag\/[\w-]+|opentelemetry-exporter[\w-]*|@opentelemetry\/exporter[\w-]*|applicationinsights)$/i;
  for (const d of input.dependencies.slice(0, 600)) {
    const name = d.package.name;
    if (d.context === 'auxiliary' || d.relationship === 'development' || d.relationship === 'test')
      continue;
    if (ANALYTICS_DEP.test(name))
      push(
        {
          family: 'privacy',
          category: 'analytics',
          mode: 'DIRECT',
          confidence: 0.85,
          source: 'dependency',
          detail: name.slice(0, 80),
        },
        `dep-a|${name}`,
      );
    else if (TELEMETRY_DEP.test(name))
      push(
        {
          family: 'privacy',
          category: 'telemetry',
          mode: 'INFERRED',
          confidence: 0.75,
          source: 'dependency',
          detail: name.slice(0, 80),
        },
        `dep-t|${name}`,
      );
    for (const a of AI_DEPENDENCIES)
      if (a.re.test(name.replace(/^.*:/, '')))
        push(
          {
            family: 'ai',
            category: a.category,
            mode: 'DIRECT',
            confidence: 0.85,
            source: 'dependency',
            detail: `${a.label}: ${name.slice(0, 60)}`,
          },
          `dep-ai|${name}`,
        );
  }

  // Model weights and dataset files by name.
  let weights = 0;
  for (const p of input.treePaths) {
    if (/(?:^|\/)(?:node_modules|vendor|tests?|__tests__|fixtures?)\//i.test(p)) continue;
    if (
      WEIGHT_STRICT.test(p) ||
      (WEIGHT_PATH.test(p) && /(?:model|weights?|checkpoint|ckpt)/i.test(p))
    ) {
      if (weights++ < 10)
        push(
          {
            family: 'ai',
            category: 'model_weights',
            mode: 'DIRECT',
            confidence: WEIGHT_STRICT.test(p) ? 0.85 : 0.6,
            source: 'path',
            file: p,
          },
          `w|${p}`,
        );
    }
  }
  const dataFiles = input.treePaths.filter((p) =>
    /(?:^|\/)(?:data|datasets?)\/.+\.(?:csv|parquet|jsonl|tsv|arrow)$/i.test(p),
  );
  if (dataFiles.length > 0)
    push(
      {
        family: 'ai',
        category: 'dataset',
        mode: 'INFERRED',
        confidence: 0.55,
        source: 'path',
        file: dataFiles[0] as string,
        detail: `${dataFiles.length} data file(s)`,
      },
      'dataset-files',
    );
  return out;
}

/** Observed categories with the best confidence per category. */
export function summarizeIndicators(list: TechnicalIndicator[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of list)
    m.set(
      `${i.family}.${i.category}`,
      Math.max(m.get(`${i.family}.${i.category}`) ?? 0, i.confidence),
    );
  return m;
}
