import type {
  AuthProvider,
  SecretsProvider,
  ForgeClient,
  GitClient,
  CodeIndex,
  Embedder,
  LLMProvider,
} from '@devdigest/shared';
import type { AppConfig } from './config.js';
import type { Db } from '../db/client.js';
import { JobRunner } from './jobs.js';
import { runBus, type RunBus } from './sse.js';
import { LocalSecretsProvider } from '../adapters/secrets/local.js';
import { LocalNoAuthProvider } from '../adapters/auth/local.js';
import { OctokitGitHubClient } from '../adapters/github/octokit.js';
import { SimpleGitClient } from '../adapters/git/simple-git.js';
import { RipgrepCodeIndex } from '../adapters/codeindex/ripgrep.js';
import { OpenAIProvider } from '../adapters/llm/openai.js';
import { AnthropicProvider } from '../adapters/llm/anthropic.js';
import { OpenAIEmbedder } from '../adapters/embedder/openai.js';
import { OpenRouterProvider } from '@devdigest/reviewer-core';
import { estimateCost } from '../adapters/llm/pricing.js';
import { PriceBook } from './price-book.js';
import { ConfigError } from './errors.js';
import { BitbucketClient } from '../adapters/bitbucket/rest.js';
import { AgentsRepository } from '../modules/agents/repository.js';
import { ReviewRepository } from '../modules/reviews/repository.js';
import type { RepoIntel } from '../modules/repo-intel/types.js';
import { RepoIntelService } from '../modules/repo-intel/service.js';
import { ContextService } from '../modules/context/service.js';
import { SkillsService } from '../modules/skills/service.js';
import { AgentsService } from '../modules/agents/service.js';
import { resolveFeatureModel } from '../modules/settings/feature-models.js';
import type { SkillsPort, AgentsPort } from '../modules/_shared/ports.js';
import type { FeatureModelChoice, FeatureModelId } from '@devdigest/shared';
import { type DepGraph, DepCruiseGraph } from '../adapters/depgraph/index.js';
import { type Tokenizer, TiktokenTokenizer } from '../adapters/tokenizer/index.js';

/**
 * DI container. One per app instance. Holds config, db, the JobRunner,
 * the SSE bus, and lazily-constructed adapters resolved through SecretsProvider.
 *
 * Tests construct a container with `overrides` to inject mock adapters; the
 * Services depend on these interfaces, not the concrete classes.
 */
export interface ContainerOverrides {
  secrets?: SecretsProvider;
  auth?: AuthProvider;
  forge?: Partial<Record<'github' | 'bitbucket', ForgeClient>>;
  git?: GitClient;
  codeIndex?: CodeIndex;
  embedder?: Embedder;
  /** Pre-built providers by id (skip key lookup). */
  llm?: Partial<Record<'openai' | 'anthropic' | 'openrouter', LLMProvider>>;
  /** repo-intel facade (T1.1+) — tests inject mock RepoIntel implementations. */
  repoIntel?: RepoIntel;
  /** Project Context reader (L05 T1) — tests inject a stub ContextService. */
  context?: ContextService;
  /** repo-intel T3 adapters — only the indexer pipeline reads these. */
  depgraph?: DepGraph;
  tokenizer?: Tokenizer;
  /** Cross-module ports — tests inject in-memory implementations. */
  skills?: SkillsPort;
  agents?: AgentsPort;
  /** Override resolveFeatureModel for tests that don't seed the settings table. */
  featureModelResolver?: (
    workspaceId: string,
    id: FeatureModelId,
  ) => Promise<FeatureModelChoice>;
}

export class Container {
  readonly config: AppConfig;
  readonly db: Db;
  readonly secrets: SecretsProvider;
  readonly auth: AuthProvider;
  readonly jobs: JobRunner;
  readonly runBus: RunBus;

  private _git?: GitClient;
  private _forgeClients = new Map<string, ForgeClient>();
  private _codeIndex?: CodeIndex;
  private _embedder?: Embedder;
  private llmCache = new Map<string, LLMProvider>();

  // Shared repositories for cross-cutting entities (agents, reviews/pulls,
  // runs). Constructed here, in the composition root, so consuming modules use
  // `container.agentsRepo` instead of reaching into another module's folder.
  private _agentsRepo?: AgentsRepository;
  private _reviewRepo?: ReviewRepository;
  private _repoIntel?: RepoIntel;
  private _context?: ContextService;
  private _depgraph?: DepGraph;
  private _tokenizer?: Tokenizer;
  private _priceBook?: PriceBook;
  private _skills?: SkillsPort;
  private _agents?: AgentsPort;

  constructor(config: AppConfig, db: Db, private overrides: ContainerOverrides = {}) {
    this.config = config;
    this.db = db;
    this.secrets = overrides.secrets ?? new LocalSecretsProvider(config.secretsPath);
    this.auth = overrides.auth ?? new LocalNoAuthProvider(db);
    this.runBus = runBus;
    this.jobs = new JobRunner(db);
  }

  get git(): GitClient {
    if (this.overrides.git) return this.overrides.git;
    this._git ??= new SimpleGitClient(this.config.cloneDir);
    return this._git;
  }

  get agentsRepo(): AgentsRepository {
    return (this._agentsRepo ??= new AgentsRepository(this.db));
  }

  get reviewRepo(): ReviewRepository {
    return (this._reviewRepo ??= new ReviewRepository(this.db));
  }

  get codeIndex(): CodeIndex {
    if (this.overrides.codeIndex) return this.overrides.codeIndex;
    this._codeIndex ??= new RipgrepCodeIndex(this.git);
    return this._codeIndex;
  }

  /**
   * The repo-intel facade (T1.1). All higher-level features (reviews,
   * blast/onboarding migrations, phantom-gate) code against this interface.
   * Tests inject a mock via `ContainerOverrides.repoIntel`.
   */
  get repoIntel(): RepoIntel {
    if (this.overrides.repoIntel) return this.overrides.repoIntel;
    this._repoIntel ??= new RepoIntelService(this);
    return this._repoIntel;
  }

  /**
   * Project Context reader (L05 T1) — discovers repo markdown under the
   * configured discovery roots (`config.contextRoots`) and exposes
   * `listPaths()`, the shared whitelist primitive later attach/pre-flight
   * work (T2/T3/T4) reuses. Tests inject a stub via `ContainerOverrides.context`.
   */
  get context(): ContextService {
    if (this.overrides.context) return this.overrides.context;
    this._context ??= new ContextService(this);
    return this._context;
  }

  /** Import-graph builder (dependency-cruiser). T3 indexer pipeline only. */
  get depgraph(): DepGraph {
    if (this.overrides.depgraph) return this.overrides.depgraph;
    this._depgraph ??= new DepCruiseGraph();
    return this._depgraph;
  }

  /** Token counter (js-tiktoken) for the repo-map budget search. */
  get tokenizer(): Tokenizer {
    if (this.overrides.tokenizer) return this.overrides.tokenizer;
    this._tokenizer ??= new TiktokenTokenizer();
    return this._tokenizer;
  }

  /**
   * Skills port. Conventions (and any future module) consumes the skills
   * capability through this port instead of importing SkillsService directly,
   * keeping module-to-module dependencies one-way through the container.
   */
  get skills(): SkillsPort {
    if (this.overrides.skills) return this.overrides.skills;
    this._skills ??= new SkillsService(this);
    return this._skills;
  }

  /** Agents port. Same rationale as `skills` — single source of cross-module wiring. */
  get agents(): AgentsPort {
    if (this.overrides.agents) return this.overrides.agents;
    this._agents ??= new AgentsService(this);
    return this._agents;
  }

  /**
   * Resolve `id` to a concrete provider+model for this workspace: workspace
   * override, else the registry default. Cross-module callers (e.g. conventions
   * extractor) use this instead of importing from `modules/settings/`.
   */
  async resolveFeatureModel(
    workspaceId: string,
    id: FeatureModelId,
  ): Promise<FeatureModelChoice> {
    if (this.overrides.featureModelResolver) {
      return this.overrides.featureModelResolver(workspaceId, id);
    }
    return resolveFeatureModel(this, workspaceId, id);
  }

  /**
   * Live OpenRouter pricing for cost attribution. The lister builds a bare
   * OpenRouter provider just for `/models` (no estimator needed) and degrades to
   * `[]` when no key is configured; the static `estimateCost` table is the
   * fallback for OpenAI/Anthropic and a cold/cold-failed cache.
   */
  get priceBook(): PriceBook {
    this._priceBook ??= new PriceBook(async () => {
      try {
        const key = await this.secrets.get('OPENROUTER_API_KEY');
        if (!key) return [];
        return await new OpenRouterProvider(key).listModels();
      } catch {
        return [];
      }
    }, estimateCost);
    return this._priceBook;
  }

  async forgeClient(provider: 'github' | 'bitbucket'): Promise<ForgeClient> {
    const injected = this.overrides.forge?.[provider];
    if (injected) return injected;
    const cached = this._forgeClients.get(provider);
    if (cached) return cached;
    if (provider === 'github') {
      const token = await this.secrets.get('GITHUB_TOKEN');
      if (!token) throw new ConfigError('GITHUB_TOKEN is not configured');
      const client = new OctokitGitHubClient(token);
      this._forgeClients.set(provider, client);
      return client;
    }
    // Bitbucket: OAuth token OR App Password (token wins if both present)
    const token = await this.secrets.get('BITBUCKET_TOKEN');
    const username = await this.secrets.get('BITBUCKET_USERNAME');
    const appPassword = await this.secrets.get('BITBUCKET_APP_PASSWORD');
    if (!token && !(username && appPassword)) {
      throw new ConfigError('Bitbucket credentials not configured — add BITBUCKET_TOKEN or BITBUCKET_USERNAME + BITBUCKET_APP_PASSWORD in Settings');
    }
    const client = new BitbucketClient({
      token: token ?? undefined,
      username: username ?? undefined,
      appPassword: appPassword ?? undefined,
    });
    this._forgeClients.set(provider, client);
    return client;
  }

  /** Resolve an LLM provider by id; constructs from the secret key, cached. */
  async llm(id: 'openai' | 'anthropic' | 'openrouter'): Promise<LLMProvider> {
    const injected = this.overrides.llm?.[id];
    if (injected) return injected;
    const cached = this.llmCache.get(id);
    if (cached) return cached;
    const provider = await this.buildLlm(id);
    this.llmCache.set(id, provider);
    return provider;
  }

  private async buildLlm(id: 'openai' | 'anthropic' | 'openrouter'): Promise<LLMProvider> {
    if (id === 'openai') {
      const key = await this.secrets.get('OPENAI_API_KEY');
      if (!key) throw new ConfigError('OPENAI_API_KEY is not configured');
      return new OpenAIProvider(key);
    }
    if (id === 'openrouter') {
      // Single OpenRouter provider lives in reviewer-core (shared with the CI
      // runner); inject the PriceBook so cost attribution uses LIVE OpenRouter
      // prices (with the static table as a fallback) rather than a hardcoded one.
      const key = await this.secrets.get('OPENROUTER_API_KEY');
      if (!key) throw new ConfigError('OPENROUTER_API_KEY is not configured');
      return new OpenRouterProvider(key, {
        estimateCost: (model, tokensIn, tokensOut) =>
          this.priceBook.estimate(model, tokensIn, tokensOut),
      });
    }
    const key = await this.secrets.get('ANTHROPIC_API_KEY');
    if (!key) throw new ConfigError('ANTHROPIC_API_KEY is not configured');
    return new AnthropicProvider(key);
  }

  async embedder(): Promise<Embedder> {
    // Injected embedders (tests) always win. Otherwise embeddings are gated by
    // config: when disabled we throw BEFORE constructing the OpenAI client, so
    // the app makes ZERO OpenAI requests. All callers wrap this in try/catch and
    // degrade gracefully (memory/RAG simply returns no hits).
    if (this.overrides.embedder) return this.overrides.embedder;
    if (!this.config.embeddingsEnabled) {
      throw new ConfigError('Embeddings are disabled (set EMBEDDINGS_ENABLED=true to enable memory/RAG)');
    }
    if (this._embedder) return this._embedder;
    const openai = await this.llm('openai');
    this._embedder = new OpenAIEmbedder(openai);
    return this._embedder;
  }

  /**
   * Drop cached provider clients so the next resolve picks up changed secrets.
   * Call after persisting a new API key/PAT via SecretsProvider.set.
   */
  invalidateSecretCaches(): void {
    this.llmCache.clear();
    this._forgeClients.clear();
    this._embedder = undefined;
  }
}
