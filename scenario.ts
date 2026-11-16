// The viewer identity: the forge serves one user, the login the trial's bearer
// token names. The suite's scenario is a fixed, seeded data set shared by every
// trial (its seed never changes between the live pass, the replay and a local
// practice run), so the login is a pure function of that seed. This module
// re-derives it from the seed with a small deterministic PRNG, the same way the
// suite builds its scenario: a named stream starts from the seed mixed with an
// FNV-1a hash of the label, and the first user of the 'users' stream is the
// viewer. No clock, no randomness, no environment read beyond the constant.
//
// The seed and the name lists are the contest's public fixed data, published in
// the kit's wire contract; the derivation below is this forge's own code.

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];

const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

/** FNV-1a over the label's UTF-16 code units, 64-bit. */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer, mixing every bit of the value into every other. */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** A named stream's starting state: the scenario seed xored with the label hash, mixed. */
function streamSeed(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64*: three shifts and one multiply, 64-bit state. */
class Stream {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, max), unbiased by rejection sampling. */
  nextInt(max: number): number {
    if (max === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % max);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % max;
    }
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.nextInt(items.length)];
    if (item === undefined) throw new Error('pick from an empty list');
    return item;
  }
}

/** The login of the first user the scenario builds: the token owner's login. */
function deriveViewerLogin(): string {
  const rng = new Stream(streamSeed('users'));
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  return `${first}${last}`.replace(/[^a-z0-9-]/g, '');
}

/** The login the trial's token names, and the only owner this forge serves. */
export const VIEWER_LOGIN: string = deriveViewerLogin();

/** The viewer's id and mail address, as the scenario builds them. */
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = `${VIEWER_LOGIN}@example.invalid`;

/** The fixed timestamp every created/updated record carries (deterministic replay). */
export const FIXED_TIMESTAMP = '2026-11-14T06:30:00Z';

/** The epoch (seconds) the forge's own commit clock starts from. */
export const COMMIT_EPOCH_SEC = 1_735_689_600;
