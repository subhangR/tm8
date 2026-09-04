/**
 * THE CANONICAL HELP LIBRARY — 55 plates, owned by this repository.
 *
 * Help used to be read from the Space's `tm8 Help` collection at run time, so a
 * node that could not reach its graph had no field guide. The owner ruled the
 * other way on 2026-08-20: Help SHIPS WITH THE APPLICATION. Every plate below
 * is a byte-exact copy of a published artifact revision, vendored into
 * `./plates/` and served as a static asset. Nothing in the reading path talks
 * to the graph.
 *
 * THE GRAPH IS STILL THE AUTHORING SURFACE, and `provenance` is the receipt
 * that says so: the artifact id, the immutable revision those bytes came from,
 * the task that commissioned it, and the SHA-256 of the vendored file. An
 * `artifact export <artifactId> --revision <revision>` reproduces the file in
 * `./plates/` exactly — `help-plates.provenance.test.ts` pins the hashes so a
 * hand-edited plate cannot pass as a published one.
 *
 * ADDING A PLATE IS A SMALL, EXPLICIT CODE CHANGE, by design and not by
 * accident. Export the revision, drop `NN-slug.html` into `./plates/`, add one
 * entry here. The number is the plate's GLOBAL address across the whole guide
 * and the section is its chapter in the approved content tree; neither is
 * derived from the file, because a reading order that a filename could change
 * is not an editorial decision.
 *
 * THE NUMBERS ARE NOT THE COLLECTION'S `contains.props.position`. Six plates
 * (3–8) were published before the flat renumbering and still sit at 101–103 and
 * 201–203 in the live collection; five older v1-fleet artifacts sit at 3, 301,
 * 302, 401 and 501 and are NOT part of this guide. This file is where the
 * canonical order was finally written down.
 */

/** The chapters of the approved Help content tree, in reading order. */
export type HelpSectionId = '0' | 'A' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8';

/** Where a plate's bytes came from, and how to get them again. */
export interface HelpPlateProvenance {
  /** The published graph artifact these bytes were exported from. */
  readonly artifactId: string;
  /** The immutable revision of that artifact. Never "latest". */
  readonly revision: number;
  /** The task that commissioned the plate; its receipt has the full QA record. */
  readonly sourceTaskId: string;
  /** SHA-256 of the vendored file, pinned by test. */
  readonly sha256: string;
  /** Size of the vendored file in bytes, pinned by the same test. */
  readonly bytes: number;
}

export interface HelpPlateDefinition {
  /** Global plate number, 1-based, unique, and the guide's reading order. */
  readonly number: number;
  /** URL-safe address, also the `NN-slug.html` filename stem. */
  readonly slug: string;
  readonly title: string;
  /**
   * The plate's OWN opening sentence, lifted verbatim from its `<p class="lede">`
   * at vendor time. The contents list needs a line under each title and the
   * truth floor forbids writing a new one here: a summary composed in the shell
   * is a claim about a page nobody checked against the page.
   */
  readonly lede: string;
  readonly section: HelpSectionId;
  readonly provenance: HelpPlateProvenance;
}

export const HELP_PLATES: readonly HelpPlateDefinition[] = [
  {
    number: 1,
    slug: 'one-conversation-one-graph',
    title: 'One conversation, one graph',
    lede: 'A request becomes durable work while you watch. Drive the five-frame record: the thread and the graph are two views of the same tm8 run.',
    section: '0',
    provenance: {
      artifactId: '01a01e1d-1c94-7bb1-8574-9bc28ffa0458',
      revision: 1,
      sourceTaskId: '01a01e09-2f19-75b8-8194-413eae441083',
      sha256: '23152ce67d69950c947549e126f7dc1541f595ee2ecbd3c1827164ca9194b59c',
      bytes: 57181,
    },
  },
  {
    number: 2,
    slug: 'three-shapes-of-the-same-thing',
    title: 'Three shapes of the same thing',
    lede: 'A tm8 Server does not change its nature when its address changes. Drive the switch to see one node unfold, become a shared hub, then join named routes to other complete nodes.',
    section: 'A',
    provenance: {
      artifactId: '01a01e1b-da8e-769a-8b0e-2a096d41e68c',
      revision: 3,
      sourceTaskId: '01a01e09-2f16-744f-813d-b602351888df',
      sha256: 'f5c01d7fb62060ce71fcb89d654b58fd7dfabe25f504b0585c87ce315924f8f7',
      bytes: 55579,
    },
  },
  {
    number: 3,
    slug: 'one-catalog-three-doors',
    title: 'One catalog, three doors',
    lede: 'Choose an action, then enter through CLI, UI, or Chat. You will watch the surface-specific gesture become one catalog operation, one graph transaction, and one durable event.',
    section: 'A',
    provenance: {
      artifactId: '01a01e1b-0da4-7e42-a0e1-8f779a918960',
      revision: 4,
      sourceTaskId: '01a01e09-2f16-744d-b40f-91a177997114',
      sha256: '247e2515295a2f397c2801e9c227181758d32c750616218e682340648e95f0a2',
      bytes: 52779,
    },
  },
  {
    number: 4,
    slug: 'a-real-terminal-streamed',
    title: 'A real terminal, streamed',
    lede: 'An agent is a real process in a server-hosted terminal. Drive the recorded sequence to see the same ordered bytes arrive in the browser — no copied transcript, no second execution.',
    section: 'A',
    provenance: {
      artifactId: '01a01e35-542e-7d65-a2bc-0e2bb60dd21e',
      revision: 3,
      sourceTaskId: '01a01e2c-941e-7284-91fe-40f881f23692',
      sha256: '633e0e198670c56815642facd5ba3a5ab2d771e074fbc178fb71e04da043410e',
      bytes: 56739,
    },
  },
  {
    number: 5,
    slug: 'who-gets-to-act',
    title: 'Who gets to act',
    lede: 'A Server begins with one claim, admits people by invitation, and gives a running session exactly one teammate identity. Drive the ledger to see each actor enter the graph.',
    section: 'A',
    provenance: {
      artifactId: '01a01e38-9a40-72c1-be4e-12471a12e395',
      revision: 3,
      sourceTaskId: '01a01e2c-93ea-750d-96c2-a2efb479e461',
      sha256: '37824c7d583ceba27f5d30b855a6ca6f8a16bdf000118602560c9b16707b5ec1',
      bytes: 54903,
    },
  },
  {
    number: 6,
    slug: 'from-zero-to-claimed',
    title: 'From zero to claimed',
    lede: 'Drive one representative Linux service install from a fresh checkout to a claimed tm8 node. The terminal carries source-shaped output; the plate beside it shows what each line makes true.',
    section: '1',
    provenance: {
      artifactId: '01a01e3c-810c-79b0-8049-8e82799d4007',
      revision: 3,
      sourceTaskId: '01a01e2c-93f0-7ad2-b0d9-88c6a1e2a229',
      sha256: 'ba953249d210979be74372d7dd0298f9b1568ee9cfb00f124255c7df563ed6f1',
      bytes: 64778,
    },
  },
  {
    number: 7,
    slug: 'the-doctors-office',
    title: 'The doctor’s office',
    lede: 'tm8 doctor asks eight concrete questions before you trust a node. Replay the healthy examination, then open any drawer to see the failure tm8 reports and the repair it prescribes.',
    section: '1',
    provenance: {
      artifactId: '01a01e36-59ac-7444-b243-a04ce7fa4068',
      revision: 2,
      sourceTaskId: '01a01e2c-940d-7bdf-a176-1229d492bbee',
      sha256: '074c439a966b483648a54d0d8d2d885bbc3ee8032f4d8de292cff385e22fbcfb',
      bytes: 62924,
    },
  },
  {
    number: 8,
    slug: 'the-invite',
    title: 'The invite',
    lede: 'One person mints a bearer code; another chooses the browser or CLI. Drive the exchange and watch exactly where the password, membership, and authority boundaries hold.',
    section: '1',
    provenance: {
      artifactId: '01a01e37-da00-7d21-b4a2-cf420a4faf5f',
      revision: 3,
      sourceTaskId: '01a01e2c-9422-744b-a5f6-46101ccd4a93',
      sha256: 'd3ea28c48da622a21f38ec84a59b2ef03f06ea9ff92c3852c4636e41009378fb',
      bytes: 66190,
    },
  },
  {
    number: 9,
    slug: 'the-graph-assembling',
    title: 'The graph, assembling',
    lede: 'Begin with an empty Space. Add five ordinary things. Watch a working context appear—one truthful link at a time.',
    section: '2',
    provenance: {
      artifactId: '01a01e7c-e494-7d50-90d3-2e1084d4a25d',
      revision: 2,
      sourceTaskId: '01a01e73-a6d0-76db-9f9c-878fca837f7d',
      sha256: '3912369f323c520204cdb2dcd6ab871fecc87f5d4b6291134690473f8b28fd44',
      bytes: 49228,
    },
  },
  {
    number: 10,
    slug: 'an-agent-builds-its-context',
    title: 'An agent builds its context',
    lede: 'A task is only the first card. Drive the reading lens across its hierarchy and edges; watch the useful neighborhood gather into a bounded folio before the agent begins.',
    section: '2',
    provenance: {
      artifactId: '01a01e7e-3f55-72a1-baf9-bfeaf1ac50d6',
      revision: 3,
      sourceTaskId: '01a01e73-a68e-71eb-908e-f3e2f94de680',
      sha256: '769a584450b85d250b54c2dfff1ce2256e2f692a020e18228c8686043006a576',
      bytes: 113518,
    },
  },
  {
    number: 11,
    slug: 'build-one',
    title: 'Build one',
    lede: 'The shared design layer every tm8 Help artifact is built on. This page is the spec and the living demo at once: every token, component, convention and motion rule below is rendered by the same foundation block you will copy into your artifact. Read it once; a fresh session with no other context should produce work indistinguishable in style from the rest of the fleet.',
    section: '2',
    provenance: {
      artifactId: '01a01e7a-f2da-76b5-bff0-a8d09421daa0',
      revision: 2,
      sourceTaskId: '01a01e73-a6cb-79f5-b5a9-8e14f52ab0f2',
      sha256: '6850b2f7e6027712e4fe9536a9c10b2633fb66672ec291ea31c619d46d28a598',
      bytes: 110583,
    },
  },
  {
    number: 12,
    slug: 'shelves-not-folders',
    title: 'Shelves, not folders',
    lede: 'A collection gathers different kinds without moving or copying them. Drive the press once: assemble a shelf, slide the kind lens across it, then remove one membership without touching the entity.',
    section: '2',
    provenance: {
      artifactId: '01a01e7c-deec-768a-bb32-219256635c2e',
      revision: 2,
      sourceTaskId: '01a01e73-a6f0-758a-930f-e96dbbdebbdc',
      sha256: 'a8230f33ccf4ceaeb02498a5dbd6e673225eac1f27642e9221d6083296c5c2c0',
      bytes: 62265,
    },
  },
  {
    number: 13,
    slug: 'anatomy-of-a-teammate',
    title: 'Anatomy of a teammate',
    lede: 'A teammate is a durable team_member entity: identity outside, a mission inside, and one catalog model underneath. Change the model and tm8 stays tm8.',
    section: '3',
    provenance: {
      artifactId: '01a01e8f-3367-72c8-8f40-3374c3bc47f0',
      revision: 1,
      sourceTaskId: '01a01e7f-52bf-7292-8f8a-5a865ea6028f',
      sha256: '513374380908e03da7ecb63288ad474169a6b0ce1af80afc6de0b0eccb4a5cf7',
      bytes: 59746,
    },
  },
  {
    number: 14,
    slug: 'a-teammate-equipped',
    title: 'A teammate, equipped',
    lede: 'A teammate is the durable identity. Its equipped skills become instructions in the next session’s launch manifest—so you can compose who works with how they work.',
    section: '3',
    provenance: {
      artifactId: '01a01e95-b1ed-7f2f-8284-4468c792c7f7',
      revision: 1,
      sourceTaskId: '01a01e7f-560b-799e-bb26-5ba0608fe98f',
      sha256: '8b09200184eb8d7721ecf8b23a4d5ec83af181e3145ace1174df917b11426c98',
      bytes: 64655,
    },
  },
  {
    number: 15,
    slug: 'what-a-teammate-remembers',
    title: 'What a teammate remembers',
    lede: 'A teammate carries a durable working set through remembers edges. At spawn, you can add one-session memory with --memory; memories the task remembers arrive automatically after the persona working set.',
    section: '3',
    provenance: {
      artifactId: '01a01e8e-462a-7f63-bd40-a8206d41b418',
      revision: 1,
      sourceTaskId: '01a01e7f-5983-7307-825c-fcd56264a707',
      sha256: 'c1830e07ff5e330dec8847a6a902ec045e6bf44e1f2848e57980eeab79fb36de',
      bytes: 59561,
    },
  },
  {
    number: 16,
    slug: 'the-house-teammates',
    title: 'The house teammates',
    lede: 'A Space begins with a small house roster: nine blank starting points, one per catalog model, plus two keepers with narrow jobs. Pick a name, then change the launch posture to see what belongs to the teammate—and what belongs only to its session.',
    section: '3',
    provenance: {
      artifactId: '01a01e90-a360-75b0-ba43-806e8053a60d',
      revision: 1,
      sourceTaskId: '01a01e7f-5e5d-7932-acb7-f0255d00e967',
      sha256: '3afaa327f92874c22134488c40598cf79e107db6fae2d0f6a57ec497400f2626',
      bytes: 109572,
    },
  },
  {
    number: 17,
    slug: 'spawning',
    title: 'Spawning',
    lede: 'A teammate is who; a session is now. Drive a launch manifest through the one spawn path and see the real process that comes out.',
    section: '3',
    provenance: {
      artifactId: '01a01e91-966d-7704-bbae-7514e9eb65f0',
      revision: 2,
      sourceTaskId: '01a01e7f-628c-7e47-a181-6aa4c0c8fd1a',
      sha256: 'b36b52d82d50f672100ab1d3663059170fdfe8c3f3f7fa77d993f952077913ff',
      bytes: 62174,
    },
  },
  {
    number: 18,
    slug: 'the-life-of-a-session',
    title: 'The life of a session',
    lede: 'A teammate is durable; a session is one running instance of it. Drive this timeline from spawn to exit, then watch resume relaunch the same conversation.',
    section: '3',
    provenance: {
      artifactId: '01a01e8e-767b-7e39-9048-0fc5ab4da99b',
      revision: 2,
      sourceTaskId: '01a01e7f-6640-780d-9c1d-8c253265181e',
      sha256: 'ec87887349f4bbf5113e317e0a0e45948a2546d2317fab183c0ed838c31c62f3',
      bytes: 66439,
    },
  },
  {
    number: 19,
    slug: 'the-four-questions',
    title: 'The four questions',
    lede: 'A session is a real process, but no single field tells you its whole story. Ask four separate questions to learn whether it is alive, what it said, what it was told, and what tm8 commands it ran.',
    section: '3',
    provenance: {
      artifactId: '01a01e9d-1b7f-73c6-82f0-49ba8d6d2d68',
      revision: 1,
      sourceTaskId: '01a01e7f-69b4-7072-8429-de5ccdc6fb9e',
      sha256: '230a5ffeba57b9ffad9b704a0d97a79f127ee85648c7974b6acc56d7df5896c8',
      bytes: 47441,
    },
  },
  {
    number: 20,
    slug: 'allowed-and-how-hard-to-think',
    title: 'Allowed, and how hard to think',
    lede: 'A session launch has two separate controls: its access posture and its reasoning effort. Set both, then drive the child-spawn sequence to see the one inheritance rule tm8 promises.',
    section: '3',
    provenance: {
      artifactId: '01a01e8f-2cbe-72e9-b7ba-2d9869427056',
      revision: 1,
      sourceTaskId: '01a01e7f-6e7c-761d-a779-c3eb6370ef66',
      sha256: '042984fb410c3206ea8d4702b5016af533d831838d366908ac1dee838e574189',
      bytes: 104954,
    },
  },
  {
    number: 21,
    slug: 'where-the-session-works',
    title: 'Where the session works',
    lede: 'Choose the ground under a session, then drive an isolated lane from --base-ref to a safe resting state. The server computes every path; you choose only the intent.',
    section: '3',
    provenance: {
      artifactId: '01a01e98-4cb9-743e-a5c4-9d78107bc190',
      revision: 1,
      sourceTaskId: '01a01e7f-7301-781e-8fed-1a11a7494c77',
      sha256: '29f56772329f59fcf6dd2ca6ae4d42e43febdc628c4e4d578d4a3c885ed09192',
      bytes: 69096,
    },
  },
  {
    number: 22,
    slug: 'dispatch',
    title: 'Dispatch',
    lede: 'Give tm8 the work before you know who should take it. The space’s Dispatcher routes the entity, prepares the context, and records its reason; it does not do the work.',
    section: '3',
    provenance: {
      artifactId: '01a01e8e-c5ae-768d-b331-b6deb6eb665d',
      revision: 2,
      sourceTaskId: '01a01e7f-7628-74ca-9cf5-91ed7e2cdac4',
      sha256: 'b8a55a3f3ceadf13dbf47fdf744a769e1bb1e04eae97db0b67366c761c4cddec',
      bytes: 57238,
    },
  },
  {
    number: 23,
    slug: 'the-dreamers-sweep',
    title: 'The Dreamer’s sweep',
    lede: 'Dreamer is a seeded teammate with an enabled every 1d loop. Each sweep marks suspect memories from pinned evidence, then consolidates the working set without erasing its history.',
    section: '3',
    provenance: {
      artifactId: '01a01e93-0b41-7704-bcf7-d83aa10217f2',
      revision: 1,
      sourceTaskId: '01a01e7f-799d-7213-857b-cd7d95504893',
      sha256: '6b8d13658be74aba476e6017a877ec1eb66859d78b066fea10bc184e46394921',
      bytes: 111841,
    },
  },
  {
    number: 24,
    slug: 'one-task-many-hands',
    title: 'One task, many hands',
    lede: 'A human and two agents work through different surfaces. Watch one task id and one version line move beneath all three—there are no private copies to reconcile.',
    section: '4',
    provenance: {
      artifactId: '01a01eac-b969-7761-b77b-f5b8c44f7430',
      revision: 3,
      sourceTaskId: '01a01ea4-0491-7e06-a863-29b384bd79fc',
      sha256: 'de9454056be99d72b057454d12a0872bdfd7502a0f27c1db96026459b69b949f',
      bytes: 63574,
    },
  },
  {
    number: 25,
    slug: 'four-categories-your-words',
    title: 'Four categories, your words',
    lede: 'You name the statuses. Your workflow chooses the columns. Underneath, four categories keep every entity legible to tm8.',
    section: '4',
    provenance: {
      artifactId: '01a01eae-3fea-7511-b21f-ed7d7fc74655',
      revision: 3,
      sourceTaskId: '01a01ea4-08bc-7176-9bc9-336c63066fa2',
      sha256: 'fe3787407526ee64cd77baf3bb980b7979c738808ce22c5e6d1c983929f15047',
      bytes: 71532,
    },
  },
  {
    number: 26,
    slug: 'the-road-to-done',
    title: 'The road to done',
    lede: 'A transition moves work. Completion proves it is finished. Drive one task through three honest refusals, then let it earn done.',
    section: '4',
    provenance: {
      artifactId: '01a01eac-0818-7910-9aea-09cea53cb59b',
      revision: 3,
      sourceTaskId: '01a01ea4-0d61-70a5-89b6-3faeaf14683f',
      sha256: '1f48587465a92f10322509fa03308f5ab84df1da35f27051e44c4e6df767517e',
      bytes: 61609,
    },
  },
  {
    number: 27,
    slug: 'same-work-three-views',
    title: 'Same work, three views',
    lede: 'Tree, board, and graph do not make copies. Change the projection and watch the same task entities move—their identity, work state, assignees, and relationships stay put.',
    section: '4',
    provenance: {
      artifactId: '01a01ead-c351-7bee-b0a7-c73c467487cb',
      revision: 2,
      sourceTaskId: '01a01ea4-1096-7bf1-9baa-05bc1472ebe4',
      sha256: 'c16a87344102e9bfabfae28dceade17f41d7bed9b063e455defb7f38503e5ac7',
      bytes: 54043,
    },
  },
  {
    number: 28,
    slug: 'assigned-by-name',
    title: 'Assigned, by name',
    lede: 'A task can name several people before anyone starts a session. Drive the handoff ledger to see durable assignment history stay put while the live worker changes.',
    section: '4',
    provenance: {
      artifactId: '01a01eac-376b-77cc-ae88-ae6a41d333a1',
      revision: 1,
      sourceTaskId: '01a01ea4-1402-7129-890b-4c4d577c4fd4',
      sha256: '16dfc3c8418ac1f867461622d29d786bd2a5a787abfb115f7ab368b72d59a6ef',
      bytes: 103252,
    },
  },
  {
    number: 29,
    slug: 'the-discussion-lives-on-the-task',
    title: 'The discussion lives on the task',
    lede: 'A tm8 task is not followed by a disposable chat room. The task is the conversational place: every turn becomes a durable message entity anchored back to it.',
    section: '4',
    provenance: {
      artifactId: '01a01eac-febc-7091-9d51-990784529f38',
      revision: 1,
      sourceTaskId: '01a01ea4-179c-7a72-b627-261f83216fde',
      sha256: '1ca08c71a23794f2a910fd5f4c6e7131f0e260dfb3401e5bd86cbf98f84a6d20',
      bytes: 63085,
    },
  },
  {
    number: 30,
    slug: 'humans-and-agents-one-thread',
    title: 'Humans and agents, one thread',
    lede: 'Follow one task discussion as two members and one teammate speak under their own identities. The task keeps the thread; a live session carries each new human message into the agent’s next turn.',
    section: '4',
    provenance: {
      artifactId: '01a01eb0-862a-7ba6-9c14-98bc58fcb69d',
      revision: 3,
      sourceTaskId: '01a01ea4-1b4b-7b05-9325-5f185b8187d7',
      sha256: '34f2f62a00aa6150c8c16e51f9d6e0f4445cdf246e9df8fd573798cea2d3969c',
      bytes: 62269,
    },
  },
  {
    number: 31,
    slug: 'the-wave',
    title: 'The wave',
    lede: 'A coordinator turns one large task into three isolated lanes. Drive the replay to see tasks, sessions, worktrees, messages, a blocker, a sibling reply, and one report move through the same graph.',
    section: '5',
    provenance: {
      artifactId: '01a01ed9-7f8a-7705-8662-4633bb0bffb7',
      revision: 1,
      sourceTaskId: '01a01ebe-613b-7877-b7b4-2dc6a2b173aa',
      sha256: 'ca3344bec9c5151f098b86820a355d13e3aa0a005e0156d5b30a99631147b576',
      bytes: 62433,
    },
  },
  {
    number: 32,
    slug: 'every-entity-is-a-place-to-talk',
    title: 'Every entity is a place to talk',
    lede: 'Put the discussion on the thing it is about. A result can live on a task, doc, session, or any other entity; replies stay beside the message they answer.',
    section: '5',
    provenance: {
      artifactId: '01a01ede-3b82-7f01-94e7-520f557a2764',
      revision: 1,
      sourceTaskId: '01a01ebe-687b-790d-ab43-bf775a138de8',
      sha256: '62c0f5b480b194584b68ec758d3e3c0a311cf30ad2f63ec3ab84aa1354b8b761',
      bytes: 56899,
    },
  },
  {
    number: 33,
    slug: 'a-message-becomes-the-next-turn',
    title: 'A message becomes the next turn',
    lede: 'Send a durable message to a running session and watch the same stored record arrive inside its terminal as the agent’s next turn. The agent’s answer returns as a reply to the source message.',
    section: '5',
    provenance: {
      artifactId: '01a01ee0-ed4c-7f77-94eb-617e8837c9c7',
      revision: 1,
      sourceTaskId: '01a01ebe-6d0f-72e2-9eee-02cbee5efba5',
      sha256: 'ed3b2c14e6623fcda5e734ebd4a42f6e684551e6181777a47057731616b21d28',
      bytes: 57043,
    },
  },
  {
    number: 34,
    slug: 'one-session-many-voices',
    title: 'One session, many voices',
    lede: 'Mara, Theo, Callisto, and Dreamer all address the same running session. Juniper receives each message as a separate next turn and replies through that message’s own thread, while one session keeps one growing conversation history.',
    section: '5',
    provenance: {
      artifactId: '01a01eda-3f41-7b3b-a21f-326488021126',
      revision: 1,
      sourceTaskId: '01a01ebe-72ec-7cb2-ae22-3eb6f23ed260',
      sha256: 'aacd71bd383ed55045934cd2125a939b5231e4c7641150895424aed63a656d31',
      bytes: 67571,
    },
  },
  {
    number: 35,
    slug: 'different-tools-same-citizens',
    title: 'Different tools, same citizens',
    lede: 'A claude-code session and a codex session do not need a private bridge. Give one the other’s session ID and they can talk through the graph.',
    section: '5',
    provenance: {
      artifactId: '01a01ed7-1fc7-7545-8f4e-8f011d29afcc',
      revision: 2,
      sourceTaskId: '01a01ebe-76b2-74ce-9f46-a0855c1d5278',
      sha256: '388431695b1c4ff4f4f260b802dcc9186354088d14aaf1458089dadf6cea98af',
      bytes: 49163,
    },
  },
  {
    number: 36,
    slug: 'human-or-agent-on-the-record',
    title: 'Human or agent, on the record',
    lede: 'A message does not merely look human or agent-authored. tm8 records who wrote it, where it belongs, and which parts an agent may trust as control.',
    section: '5',
    provenance: {
      artifactId: '01a01eda-737c-76cf-9182-df9ee6eca46e',
      revision: 1,
      sourceTaskId: '01a01ebe-7a4d-7228-8ec7-85c905813603',
      sha256: '82fe3ee9b710acd7ba318bc39d72c7873f8c30107a2e113ed54301592e769a23',
      bytes: 49890,
    },
  },
  {
    number: 37,
    slug: 'recursive-by-construction',
    title: 'Recursive by construction',
    lede: 'A coordinator can launch another coordinator, which can launch coordinated workers. Drive the lattice outward to see how a small set of launch modes composes into many organizational shapes.',
    section: '5',
    provenance: {
      artifactId: '01a01ed6-d63c-78ec-bc15-4ca2a846f790',
      revision: 4,
      sourceTaskId: '01a01ebe-7e26-76c4-955d-77ce254d32c0',
      sha256: '6323e2ff88bd76b262b2dc88db5a756e0969f18cb9ed119290866b57df37d483',
      bytes: 61609,
    },
  },
  {
    number: 38,
    slug: 'the-dispatcher',
    title: 'The Dispatcher',
    lede: 'You know the work needs doing, but not who should do it. Dispatch turns that uncertainty into a visible route: an existing teammate, the memories they need, a fresh work session, and a reason recorded on the task.',
    section: '5',
    provenance: {
      artifactId: '01a02007-9145-79c1-a773-cdc68ff29652',
      revision: 1,
      sourceTaskId: '01a01ebe-81e4-7120-8f00-fb1052022e8b',
      sha256: 'bfb6e13612667fbd4ef6d82407d2e206d72de9e1834f1806a5b8d09d462e69ea',
      bytes: 49697,
    },
  },
  {
    number: 39,
    slug: 'the-dreamer',
    title: 'The Dreamer',
    lede: 'Memories are useful because they enter future sessions. That is also why stale or contradictory memories can quietly poison every session that follows.',
    section: '5',
    provenance: {
      artifactId: '01a01f50-eccf-7f8f-8d48-c62b126c7a8a',
      revision: 2,
      sourceTaskId: '01a01ebe-871a-7144-8d75-93b40b54911b',
      sha256: 'e23df2ea21d99a706356c29ed99a758843e8e0e887da82caddd8d8e9ce0a0dbe',
      bytes: 64911,
    },
  },
  {
    number: 40,
    slug: 'ten-pipelines',
    title: 'Ten pipelines',
    lede: 'Pick a shape, then drive its messages one step at a time. Each setup shows who acts, where durable work lands, and the prompt language that keeps the handoffs legible.',
    section: '5',
    provenance: {
      artifactId: '01a01edb-5b7f-7345-a48a-7b9f65834248',
      revision: 1,
      sourceTaskId: '01a01ebe-8b54-781b-a75d-48a0b0c2ecd2',
      sha256: '46d865ee8c92463579b46cb33da1ba305b2bb6e0bb14f2ef54dc30fdb9b92223',
      bytes: 60637,
    },
  },
  {
    number: 41,
    slug: 'memory-rides-along',
    title: 'Memory rides along',
    lede: 'Pin what a teammate or task must remember. When that entity enters a session, its memory arrives in context before the work begins.',
    section: '6',
    provenance: {
      artifactId: '01a0200b-dd9b-71b4-a063-8719b651942e',
      revision: 1,
      sourceTaskId: '01a02001-ef77-7516-9883-4c6957f94408',
      sha256: 'b78b295c7416db8de29fec7f257304d642b19ca790a89fbe993423f0cb5b6922',
      bytes: 104840,
    },
  },
  {
    number: 42,
    slug: 'never-erased',
    title: 'Never erased',
    lede: 'Drive one repair through an append-only memory graph. Evidence disputes a wrong claim; one consolidated memory supersedes three overlaps; their durable remembers edges move without deleting the past.',
    section: '6',
    provenance: {
      artifactId: '01a02009-03a5-7919-91ee-04382b9c01ab',
      revision: 1,
      sourceTaskId: '01a02001-f3e5-7781-8324-be7543b14b63',
      sha256: 'c0da952b8d5103c492a7974070543c0df6137e62bd6725fe73fcdaaadab44e9f',
      bytes: 55105,
    },
  },
  {
    number: 43,
    slug: 'the-keepers-revisited',
    title: 'The keepers, revisited',
    lede: 'Memory work happens around the working agent, not inside its critical path. Drive one passage from spawn time to off-hours and watch Dispatcher and Dreamer divide the work.',
    section: '6',
    provenance: {
      artifactId: '01a0200f-2040-798e-95d5-cf6679f3afaf',
      revision: 1,
      sourceTaskId: '01a02001-f9db-7b19-b47e-6c230efd4dec',
      sha256: '7b2859f3205f0df445b959d3d58467224b4628d419cebb4ba9d46ac67e355837',
      bytes: 41934,
    },
  },
  {
    number: 44,
    slug: 'the-metronome',
    title: 'The metronome',
    lede: 'A loop keeps time in the graph. Drive five firings, then open any triggered_by edge: the fan itself is the run history.',
    section: '6',
    provenance: {
      artifactId: '01a0200e-9c45-73f2-ab51-be436fe6f7d6',
      revision: 1,
      sourceTaskId: '01a02001-ff12-7889-90c9-3a474aa1c1c5',
      sha256: '1a0aadb1b70180bfdc14528254d054a446f2552417df3a0d625d61093c471948',
      bytes: 48397,
    },
  },
  {
    number: 45,
    slug: 'casting-a-spell',
    title: 'Casting a spell',
    lede: 'Follow one spell from a graph entity into a session’s working set. Then cross the ink line and inspect the intended cast without mistaking it for shipped behavior.',
    section: '6',
    provenance: {
      artifactId: '01a02009-6075-7f8e-a1a3-39ae2f37b9be',
      revision: 2,
      sourceTaskId: '01a02002-0459-70f6-9704-75df2c877b93',
      sha256: 'cf99a423bec849a3a73e8534e534999d97d6d5c1fde748df2843d099186c8186',
      bytes: 55293,
    },
  },
  {
    number: 46,
    slug: 'sketch-to-reality',
    title: 'Sketch to reality',
    lede: 'A Craft blueprint is a graph entity you can edit without changing the world. Approval lands in that graph’s thread; then agents materialize its specs as real entities and edges, with links back to the plan.',
    section: '7',
    provenance: {
      artifactId: '01a0202d-94b9-7b30-93b8-2c930a85ce8d',
      revision: 2,
      sourceTaskId: '01a02024-f90e-7bc4-a823-b9ca9e67de6e',
      sha256: '46a5f5a5168dff5104ef4ad3c917f5f593b9ccf9ddd6fb8d1204595b16cdbc54',
      bytes: 109563,
    },
  },
  {
    number: 47,
    slug: 'many-hands-on-one-blueprint',
    title: 'Many hands on one blueprint',
    lede: 'Drive one plan from sketch to a coordinated wave: two real teammate sessions work its nodes at once while an orchestrator steers the same shared graph.',
    section: '7',
    provenance: {
      artifactId: '01a0202e-7c89-709f-ba90-0c43db4b3d45',
      revision: 3,
      sourceTaskId: '01a02024-f933-760b-a39a-66afe322832e',
      sha256: '23a50cf80c8e4b8dc6b268d12c4eae6e4e6d2311ee8a9d07b12862a12f428aaa',
      bytes: 55641,
    },
  },
  {
    number: 48,
    slug: 'ref-or-spec',
    title: 'Ref or spec',
    lede: 'A blueprint has two ways to name a node. Decide whether you are pointing at something that exists or sketching something that should be born.',
    section: '7',
    provenance: {
      artifactId: '01a0202b-9e45-7946-9868-e49503760a4e',
      revision: 2,
      sourceTaskId: '01a02024-f8c7-710e-bfd3-32ad2fc43cad',
      sha256: 'b7bf688e2620092836fa40691d54772add418d5ac9865e5601df549cdd28d6ff',
      bytes: 43475,
    },
  },
  {
    number: 49,
    slug: 'the-plan-stays-attached',
    title: 'The plan stays attached',
    lede: 'A task can finish without losing the blueprint that called for it. Replay one materialization wave and inspect the durable trail before, during, and after work.',
    section: '7',
    provenance: {
      artifactId: '01a02036-5755-7ef9-865a-93bd20f6ef25',
      revision: 1,
      sourceTaskId: '01a02024-f8d2-7ce9-899c-157ea979a7b0',
      sha256: '95a8821f9de533ab40121f0026b78bc0e6f3e85b947606a541e6c83ba81a6316',
      bytes: 49249,
    },
  },
  {
    number: 50,
    slug: 'one-brain-many-users',
    title: 'One brain, many users',
    lede: 'Three people can steer the same running teammate without losing who asked what. Drive one exchange from durable discussion to identified session turns and threaded replies.',
    section: '8',
    provenance: {
      artifactId: '01a0202e-2f3a-7b72-9264-c31f10fa8d17',
      revision: 4,
      sourceTaskId: '01a02024-f940-7ac7-a4d9-739133998e42',
      sha256: '18904b465b83cafdce225c1516271c7646b2c25d188bf164e108c13e180d4aaa',
      bytes: 51336,
    },
  },
  {
    number: 51,
    slug: 'the-ladder',
    title: 'The ladder',
    lede: 'The shared design layer every tm8 Help artifact is built on. This page is the spec and the living demo at once: every token, component, convention and motion rule below is rendered by the same foundation block you will copy into your artifact. Read it once; a fresh session with no other context should produce work indistinguishable in style from the rest of the fleet.',
    section: '8',
    provenance: {
      artifactId: '01a0202b-b893-7a54-ac3a-e4b7e2e702d4',
      revision: 1,
      sourceTaskId: '01a02024-fe9a-74ee-9f2e-f246dd2a8ab9',
      sha256: '138ff86dfe5527b01b75566f1b9128c6a6199a71bdc26c7d7afd8f4eba319d60',
      bytes: 106963,
    },
  },
  {
    number: 52,
    slug: 'a-channel-is-a-graph-place',
    title: 'A channel is a graph place',
    lede: 'A channel is not a chat list. It is a durable entity where people, teammates, messages, subchannels, threads, and shared work keep their own identities and relationships.',
    section: '8',
    provenance: {
      artifactId: '01a02036-e5aa-79f2-9e38-d8d031f5a98c',
      revision: 1,
      sourceTaskId: '01a02024-f93c-749a-8357-ca09af1308a0',
      sha256: '92025e0c9d20f578f2ce0fc5ec814c76be5762248b7567e5274e33d287a8721c',
      bytes: 59638,
    },
  },
  {
    number: 53,
    slug: 'the-mention-that-acts',
    title: 'The mention that acts',
    lede: 'An @teammate mention is a durable message, an inbox signal, and—when sent from a channel—a route toward the teammate’s current work.',
    section: '8',
    provenance: {
      artifactId: '01a02035-4afd-7249-af6f-f76e0c236770',
      revision: 1,
      sourceTaskId: '01a02024-f888-7f3b-a4eb-bd779a0f8b33',
      sha256: '6f2bbfb39172212a102549ed08e695b0bc6b8a46464f63c86d33d4e0cd3f4999',
      bytes: 60254,
    },
  },
  {
    number: 54,
    slug: 'same-room-own-identity',
    title: 'Same room, own identity',
    lede: 'The shared design layer every tm8 Help artifact is built on. This page is the spec and the living demo at once: every token, component, convention and motion rule below is rendered by the same foundation block you will copy into your artifact. Read it once; a fresh session with no other context should produce work indistinguishable in style from the rest of the fleet.',
    section: '8',
    provenance: {
      artifactId: '01a0202b-3eb2-7e1c-9462-ffdacd13a0e1',
      revision: 3,
      sourceTaskId: '01a02024-f93d-7d24-83df-afb357727b76',
      sha256: '57e4d57f4147497e1cd0c2ff3850adb074076c963a7082b357cb57e893ad9bb8',
      bytes: 101902,
    },
  },
  {
    number: 55,
    slug: 'six-rooms',
    title: 'Six rooms',
    lede: 'A channel is not one fixed ritual. Pick a room, then assemble its cast, session routes, shared entities, and durable message shape.',
    section: '8',
    provenance: {
      artifactId: '01a02038-df34-745a-88d9-33c96f025adb',
      revision: 1,
      sourceTaskId: '01a02024-fbf1-7fb7-855a-a4f0a0514985',
      sha256: '19e04f027d33875996bf4ca2cc15078fa21e0882bb9dd55bf61a3c01a9dedd1c',
      bytes: 62050,
    },
  },
] as const;

/**
 * Every plate's bundle, as a lazy asset-URL loader keyed by filename.
 *
 * `import.meta.glob` rather than 55 static imports: the glob is what makes the
 * bundles CODE SPLIT. Each plate becomes its own emitted asset with its own
 * content hash, fetched by the iframe only when a reader opens it, so opening
 * the app costs none of the 3.6 MB this library weighs.
 */
const PLATE_ASSETS = import.meta.glob<string>('./plates/*.html', {
  query: '?url',
  import: 'default',
});

/**
 * Resolve one plate's asset URL.
 *
 * Throws rather than returning null for an unknown slug: every caller reads
 * from `HELP_PLATES`, so a miss is a registry that has drifted from `./plates/`
 * — a build-time mistake, not a runtime condition a reader can be shown.
 */
export function loadPlateAsset(plate: HelpPlateDefinition): Promise<string> {
  const key = `./plates/${plateFileName(plate)}`;
  const loader = PLATE_ASSETS[key];
  if (!loader) throw new Error(`Help plate asset missing: ${key}`);
  return loader();
}

/** `NN-slug.html` — the one place the filename convention is spelled. */
export function plateFileName(plate: Pick<HelpPlateDefinition, 'number' | 'slug'>): string {
  return `${String(plate.number).padStart(2, '0')}-${plate.slug}.html`;
}

/** The plate a URL segment addresses, or `null` when nothing matches. */
export function plateBySlug(slug: string | null | undefined): HelpPlateDefinition | null {
  if (!slug) return null;
  return HELP_PLATES.find((plate) => plate.slug === slug) ?? null;
}
