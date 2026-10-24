import { redactErrorForLog, redactSensitiveText } from "../logging.js";

describe("bridge log redaction", () => {
  it("removes credentials, account identifiers, addresses, and signed URLs", () => {
    const input =
      'token=secret-token password:"open-sesame" user@example.com 192.0.2.4 ' +
      "https://media.example.invalid/file?auth=secret T8171ABCDEFGHI";
    const output = redactSensitiveText(input);

    for (const secret of [
      "secret-token",
      "open-sesame",
      "user@example.com",
      "192.0.2.4",
      "media.example.invalid",
      "T8171ABCDEFGHI",
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it("drops custom error fields while preserving a redacted type and message", () => {
    const error = Object.assign(
      new Error("x-auth-token: abc123 user@example.com"),
      {
        response: { auth_token: "must-not-escape" },
      },
    );

    expect(redactErrorForLog(error)).toEqual({
      name: "Error",
      message: "x-auth-token=[redacted] [redacted-email]",
    });
    expect(JSON.stringify(redactErrorForLog(error))).not.toContain(
      "must-not-escape",
    );
  });
});
