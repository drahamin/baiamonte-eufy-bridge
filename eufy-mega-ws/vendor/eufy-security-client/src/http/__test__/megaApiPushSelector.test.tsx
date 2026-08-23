import { MegaHTTPApi } from "../megaApi";

jest.mock("../../logging", () => {
  const stub = { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), trace: jest.fn() };
  return new Proxy({}, { get: () => stub });
});

/**
 * Exercises the REAL MegaTransition.registerMegaPushToken with a stubbed mega client, so the
 * best-effort v6-push wiring is genuinely covered:
 *  - no register when there is no valid v6 session (not-yet-migrated account);
 *  - register when a valid session exists;
 *  - a v6 failure is swallowed (never propagates — legacy push is unaffected).
 */
import { MegaTransition, MegaTransitionHost } from "../megaTransition";

type MegaStub = Pick<MegaHTTPApi, "hasValidSession" | "registerPushToken" | "exportSession">;

function makeTransition(mega: MegaStub | undefined, opts?: { failGetMega?: boolean }) {
  const host = {
    config: {},
    persistentData: {},
    get api() {
      return undefined as never;
    },
    writePersistentData: jest.fn(),
    emitTfaRequest: jest.fn(),
    emitCaptchaRequest: jest.fn(),
    legacyConnect: jest.fn(async () => {}),
    onAPIConnect: jest.fn(async () => {}),
    onConnectionError: jest.fn(),
  } as unknown as MegaTransitionHost;

  const transition = new MegaTransition(host);
  (transition as unknown as { getMegaApi: () => Promise<MegaHTTPApi> }).getMegaApi = jest.fn(async () => {
    if (opts?.failGetMega) throw new Error("init failed");
    return mega as MegaHTTPApi;
  });
  return { transition, host };
}

describe("MegaTransition.registerMegaPushToken (v6 best-effort)", () => {
  afterEach(() => jest.clearAllMocks());

  it("registers when a valid v6 session exists (returns true)", async () => {
    const mega = {
      hasValidSession: () => true,
      registerPushToken: jest.fn().mockResolvedValue({ code: 0, msg: "ok" }),
      exportSession: jest.fn().mockReturnValue({ cloud_token: "t" }),
    };
    const { transition, host } = makeTransition(mega);
    await expect(transition.registerMegaPushToken("tok")).resolves.toBe(true);
    expect(mega.registerPushToken).toHaveBeenCalledWith("tok");
    expect(mega.exportSession).toHaveBeenCalledTimes(1);
    expect(host.writePersistentData).toHaveBeenCalledTimes(1);
  });

  it("skips register when there is no valid session (returns false)", async () => {
    const mega = { hasValidSession: () => false, registerPushToken: jest.fn(), exportSession: jest.fn() };
    const { transition } = makeTransition(mega);
    await expect(transition.registerMegaPushToken("tok")).resolves.toBe(false);
    expect(mega.registerPushToken).not.toHaveBeenCalled();
  });

  it("returns false (never throws) when the v6 register rejects (legacy push unaffected)", async () => {
    const mega = {
      hasValidSession: () => true,
      registerPushToken: jest.fn().mockRejectedValue(new Error("401")),
      exportSession: jest.fn(),
    };
    const { transition } = makeTransition(mega);
    await expect(transition.registerMegaPushToken("tok")).resolves.toBe(false);
  });

  it("returns false (never throws) when getMegaApi itself fails", async () => {
    const { transition } = makeTransition(undefined, { failGetMega: true });
    await expect(transition.registerMegaPushToken("tok")).resolves.toBe(false);
  });

  it("returns false on a non-zero register code", async () => {
    const mega = {
      hasValidSession: () => true,
      registerPushToken: jest.fn().mockResolvedValue({ code: 10000, msg: "fail" }),
      exportSession: jest.fn(),
    };
    const { transition } = makeTransition(mega);
    await expect(transition.registerMegaPushToken("tok")).resolves.toBe(false);
  });
});
