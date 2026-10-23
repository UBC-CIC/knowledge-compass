import { useState, useEffect } from "react";
import { useNavigate, useLocation, Link } from "react-router";
import { confirmSignIn, type SignInOutput } from "aws-amplify/auth";
import { AuthService } from "@/functions/authService";
import BrandMark from "@/components/BrandMark";
import { isDemoMode } from "@/lib/demo";
import { API_ENDPOINT } from "@/lib/api";
import {
  type AdminSignInStep,
  NOT_ADMIN_MESSAGE,
  TOTP_ISSUER,
  adminSetupErrorMessage,
  adminStepFor,
  isAdminTokenPayload,
  cleanTotpCode,
  formatTotpSecret,
  totpCodeError,
} from "@/lib/adminSignIn";

const STEP_COPY: Record<AdminSignInStep, { title: string; intro: string }> = {
  credentials: {
    title: "Sign in",
    intro: "Manage the knowledge base, conversation prompts, and detective settings.",
  },
  newPassword: {
    title: "Set a new password",
    intro: "Please set a new password for your account.",
  },
  totpSetup: {
    title: "Set up two-step sign-in",
    intro: "Admin accounts use an authenticator app for a second sign-in step.",
  },
  totpCode: {
    title: "Enter your code",
    intro: "Open your authenticator app and enter the 6-digit code for Knowledge Compass.",
  },
};

export default function AdminLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [step, setStep] = useState<AdminSignInStep>("credentials");
  const [totpSetup, setTotpSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const navigate = useNavigate();
  const location = useLocation();
  const from =
    (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ||
    "/admin/dashboard";

  useEffect(() => {
    if (isDemoMode) return;

    const checkAuthStatus = async () => {
      try {
        const session = await AuthService.getAuthSession(true);
        if (!session?.tokens?.accessToken) return;
        // A kept session outside the admin group would reach the dashboard
        // only to have every admin API call refused, so end it here.
        if (isAdminTokenPayload(session.tokens.idToken?.payload)) {
          navigate(from, { replace: true });
        } else {
          await AuthService.signOut();
          setError(NOT_ADMIN_MESSAGE);
        }
      } catch {
        console.log("Not authenticated");
      }
    };

    checkAuthStatus();
  }, [navigate, from]);

  // Records the signed-in admin in the users table. Returns the HTTP status
  // of a failed call, or null on success.
  const updateAdminUser = async (token: string): Promise<number | null> => {
    const res = await fetch(`${API_ENDPOINT}/admin/promote_user`, {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    return res.ok ? null : res.status;
  };

  // Cognito accepted the credentials; the account still has to be an admin.
  // On any failure the Cognito session is ended, so a later visit to this
  // page starts a clean sign-in instead of skipping straight to a dashboard
  // that cannot load.
  const finishSignIn = async () => {
    AuthService.clearAuthCache();
    let failure: string | null = null;
    try {
      const session = await AuthService.getAuthSession(false);
      const token = AuthService.getTokenString(session?.tokens?.idToken);
      if (!token || !isAdminTokenPayload(session?.tokens?.idToken?.payload)) {
        failure = NOT_ADMIN_MESSAGE;
      } else {
        const status = await updateAdminUser(token);
        if (status !== null) failure = adminSetupErrorMessage(status);
      }
    } catch {
      failure = adminSetupErrorMessage(undefined);
    }

    if (failure) {
      await AuthService.signOut();
      startOver();
      setError(failure);
      return;
    }

    setSignedIn(true);
    navigate(from, { replace: true });
  };

  // Moves to whatever Cognito asks for next: a new password, TOTP setup, or a
  // TOTP code. Used after signIn and after every confirmSignIn.
  const continueSignIn = async (
    isSignedIn: boolean | undefined,
    nextStep: SignInOutput["nextStep"] | undefined
  ) => {
    const next = isSignedIn ? "done" : adminStepFor(nextStep?.signInStep);

    if (next === "done") {
      await finishSignIn();
      return;
    }

    if (next === null) {
      setError(
        "This account needs a sign-in step this page doesn't support. Contact another administrator for help."
      );
      return;
    }

    if (next === "totpSetup" && nextStep?.signInStep === "CONTINUE_SIGN_IN_WITH_TOTP_SETUP") {
      const { totpSetupDetails } = nextStep;
      setTotpSetup({
        secret: totpSetupDetails.sharedSecret,
        uri: totpSetupDetails.getSetupUri(TOTP_ISSUER, email.trim()).toString(),
      });
      setCopyStatus("");
    }

    setTotpCode("");
    setStep(next);
  };

  const startOver = () => {
    setStep("credentials");
    setPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setTotpCode("");
    setTotpSetup(null);
    setError("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSignedIn(false);

    if (!email.trim() || !password) {
      setError("Enter both your email and password to continue.");
      return;
    }

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      setError("That email address doesn't look complete — check for a typo.");
      return;
    }

    setIsLoading(true);

    if (isDemoMode) {
      setSignedIn(true);
      window.setTimeout(() => {
        navigate(from, { replace: true });
        setIsLoading(false);
      }, 600);
      return;
    }

    try {
      const result = await AuthService.signIn(email, password);

      if (!result.success) {
        setError(result.error || "Invalid email or password");
        return;
      }

      await continueSignIn(result.isSignedIn, result.nextStep);
    } catch (err: unknown) {
      setError((err instanceof Error && err.message) || "Invalid email or password");
    } finally {
      setIsLoading(false);
    }
  };

  const handleNewPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setIsLoading(true);

    try {
      const user = await confirmSignIn({
        challengeResponse: newPassword,
      });

      await continueSignIn(user.isSignedIn, user.nextStep);
    } catch (err: unknown) {
      setError((err instanceof Error && err.message) || "Failed to set new password");
    } finally {
      setIsLoading(false);
    }
  };

  // Handles both TOTP steps: confirming the first code finishes authenticator
  // setup; later sign-ins confirm the current code.
  const handleTotpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const code = cleanTotpCode(totpCode);
    const codeError = totpCodeError(code);
    if (codeError) {
      setError(codeError);
      return;
    }

    setIsLoading(true);

    try {
      const user = await confirmSignIn({ challengeResponse: code });
      await continueSignIn(user.isSignedIn, user.nextStep);
    } catch (err: unknown) {
      setTotpCode("");
      setError(
        (err instanceof Error && err.message) ||
          "That code didn't work. Wait for a new code and try again."
      );
    } finally {
      setIsLoading(false);
    }
  };

  const copySecret = async () => {
    if (!totpSetup) return;
    try {
      await navigator.clipboard.writeText(totpSetup.secret);
      setCopyStatus("Setup key copied.");
    } catch {
      setCopyStatus("Couldn't copy the key. Select it and copy it manually.");
    }
  };

  const ready = Boolean(email.trim() && password && !isLoading);
  const newPasswordReady = Boolean(
    newPassword && confirmPassword && !isLoading
  );
  const isCodeStep = step === "totpSetup" || step === "totpCode";
  const totpReady = Boolean(totpCode.trim() && !isLoading);
  const copy = STEP_COPY[step];

  return (
    <div className="flex min-h-screen flex-col bg-muted">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-foreground/10 bg-white px-[34px] py-[18px]">
        <BrandMark />
        <div className="text-[12.5px] font-semibold tracking-[0.02em] text-foreground/75">
          Administrator access
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-[440px]">
          <div className="rounded-[14px] border border-foreground/12 bg-white px-[34px] pb-[30px] pt-[34px] shadow-md">
            <h1 className="font-serif text-[30px] font-semibold leading-tight tracking-[-0.015em]">
              {copy.title}
            </h1>
            <p className="mt-2 text-[15px] leading-relaxed text-foreground/80">
              {step === "credentials" && isDemoMode
                ? "Local demo — any complete email and password will open the console."
                : copy.intro}
            </p>

            {/* On the code steps the error is shown under the code field instead. */}
            {error && !isCodeStep ? (
              <div
                role="alert"
                className="mt-5 rounded-[9px] border border-[oklch(0.82_0.08_25)] bg-[oklch(0.96_0.03_25)] px-3.5 py-3 text-sm leading-relaxed text-[oklch(0.38_0.13_25)]"
              >
                {error}
              </div>
            ) : null}

            {signedIn ? (
              <div className="mt-5 rounded-[9px] border border-[oklch(0.80_0.07_160)] bg-[oklch(0.96_0.03_160)] px-3.5 py-3 text-sm leading-relaxed text-[oklch(0.35_0.09_160)]">
                Signed in. Opening the admin dashboard…
              </div>
            ) : null}

            {step === "credentials" ? (
              <form onSubmit={handleSubmit} className="mt-[22px]">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="kc-email" className="text-[13px] font-bold tracking-[0.01em]">
                    Email
                  </label>
                  <input
                    id="kc-email"
                    type="email"
                    autoComplete="username"
                    placeholder="name@inclusioncanada.ca"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    disabled={isLoading}
                    className="min-h-[46px] rounded-[9px] border-[1.5px] border-foreground/20 bg-white px-3.5 text-[15.5px] text-foreground outline-none focus:outline-2 focus:outline-offset-1 focus:outline-primary"
                  />
                </div>

                <div className="mt-4 flex flex-col gap-1.5">
                  <label htmlFor="kc-pw" className="text-[13px] font-bold tracking-[0.01em]">
                    Password
                  </label>
                  <div className="relative flex">
                    <input
                      id="kc-pw"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      disabled={isLoading}
                      className="min-h-[46px] min-w-0 flex-1 rounded-[9px] border-[1.5px] border-foreground/20 bg-white py-0 pr-[92px] pl-3.5 text-[15.5px] text-foreground outline-none focus:outline-2 focus:outline-offset-1 focus:outline-primary"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute top-0 right-0 h-full min-h-11 px-3.5 text-[13px] font-semibold text-primary"
                    >
                      {showPassword ? "Hide" : "Show"}
                    </button>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3.5">
                  <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-foreground/85">
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={(e) => setRemember(e.target.checked)}
                      className="size-[17px] accent-primary"
                    />
                    Keep me signed in
                  </label>
                </div>

                <button
                  type="submit"
                  disabled={!ready}
                  className="mt-5 min-h-12 w-full rounded-[9px] text-[15.5px] font-semibold transition-colors disabled:bg-foreground/14 disabled:text-foreground/75 enabled:bg-primary enabled:text-white"
                >
                  {isLoading ? "Signing in…" : "Sign in"}
                </button>
              </form>
            ) : step === "newPassword" ? (
              <form onSubmit={handleNewPasswordSubmit} className="mt-[22px]">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="newPassword" className="text-[13px] font-bold tracking-[0.01em]">
                    New Password
                  </label>
                  <div className="relative flex">
                    <input
                      id="newPassword"
                      type={showNewPassword ? "text" : "password"}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                      disabled={isLoading}
                      placeholder="Enter new password"
                      className="min-h-[46px] min-w-0 flex-1 rounded-[9px] border-[1.5px] border-foreground/20 bg-white py-0 pr-[92px] pl-3.5 text-[15.5px] outline-none focus:outline-2 focus:outline-offset-1 focus:outline-primary"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPassword((v) => !v)}
                      className="absolute top-0 right-0 h-full min-h-11 px-3.5 text-[13px] font-semibold text-primary"
                    >
                      {showNewPassword ? "Hide" : "Show"}
                    </button>
                  </div>
                </div>

                <div className="mt-4 flex flex-col gap-1.5">
                  <label htmlFor="confirmPassword" className="text-[13px] font-bold tracking-[0.01em]">
                    Confirm New Password
                  </label>
                  <div className="relative flex">
                    <input
                      id="confirmPassword"
                      type={showConfirmPassword ? "text" : "password"}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                      disabled={isLoading}
                      placeholder="Confirm new password"
                      className="min-h-[46px] min-w-0 flex-1 rounded-[9px] border-[1.5px] border-foreground/20 bg-white py-0 pr-[92px] pl-3.5 text-[15.5px] outline-none focus:outline-2 focus:outline-offset-1 focus:outline-primary"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword((v) => !v)}
                      className="absolute top-0 right-0 h-full min-h-11 px-3.5 text-[13px] font-semibold text-primary"
                    >
                      {showConfirmPassword ? "Hide" : "Show"}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={!newPasswordReady}
                  className="mt-5 min-h-12 w-full rounded-[9px] text-[15.5px] font-semibold disabled:bg-foreground/14 disabled:text-foreground/75 enabled:bg-primary enabled:text-white"
                >
                  {isLoading ? "Setting Password..." : "Set New Password"}
                </button>
              </form>
            ) : (
              <form onSubmit={handleTotpSubmit} className="mt-[22px]" noValidate>
                {step === "totpSetup" && totpSetup ? (
                  <ol className="mb-5 flex list-decimal flex-col gap-3 pl-5 text-sm leading-relaxed text-foreground/85">
                    <li>
                      Open an authenticator app on your phone, such as Google
                      Authenticator, Microsoft Authenticator or 1Password, and
                      add a new account.
                    </li>
                    <li>
                      Choose to enter a setup key, and type this key:
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <code
                          className="rounded-[9px] border-[1.5px] border-foreground/20 bg-muted px-3 py-2 font-mono text-[14px] tracking-[0.04em] break-all text-foreground select-all"
                        >
                          {formatTotpSecret(totpSetup.secret)}
                        </code>
                        <button
                          type="button"
                          onClick={copySecret}
                          className="min-h-11 rounded-[9px] px-3.5 text-[13px] font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
                        >
                          Copy key
                        </button>
                      </div>
                      <p aria-live="polite" className="mt-1 text-[13px] text-foreground/75">
                        {copyStatus}
                      </p>
                      <p className="mt-1">
                        Using this device?{" "}
                        <a
                          href={totpSetup.uri}
                          className="font-semibold text-primary underline underline-offset-2"
                        >
                          Open the setup link in your authenticator app
                        </a>
                        .
                      </p>
                    </li>
                    <li>Enter the 6-digit code the app shows.</li>
                  </ol>
                ) : null}

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="kc-totp-code" className="text-[13px] font-bold tracking-[0.01em]">
                    6-digit code
                  </label>
                  <input
                    id="kc-totp-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9 ]*"
                    maxLength={8}
                    // The step only renders after the user submits the previous
                    // form, so moving focus here is expected.
                    autoFocus
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value)}
                    required
                    disabled={isLoading}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? "kc-totp-hint kc-totp-error" : "kc-totp-hint"}
                    className="min-h-[46px] rounded-[9px] border-[1.5px] border-foreground/20 bg-white px-3.5 font-mono text-[18px] tracking-[0.2em] text-foreground outline-none focus:outline-2 focus:outline-offset-1 focus:outline-primary aria-invalid:border-[oklch(0.55_0.15_25)]"
                  />
                  <p id="kc-totp-hint" className="text-[13px] text-foreground/75">
                    Codes change every 30 seconds.
                  </p>
                  {error ? (
                    <p
                      id="kc-totp-error"
                      role="alert"
                      className="text-sm leading-relaxed text-[oklch(0.38_0.13_25)]"
                    >
                      {error}
                    </p>
                  ) : null}
                </div>

                <button
                  type="submit"
                  disabled={!totpReady}
                  className="mt-5 min-h-12 w-full rounded-[9px] text-[15.5px] font-semibold transition-colors disabled:bg-foreground/14 disabled:text-foreground/75 enabled:bg-primary enabled:text-white"
                >
                  {isLoading
                    ? "Checking code…"
                    : step === "totpSetup"
                      ? "Verify and sign in"
                      : "Sign in"}
                </button>
                <button
                  type="button"
                  onClick={startOver}
                  disabled={isLoading}
                  className="mt-3 min-h-11 w-full rounded-[9px] text-[14px] font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
                >
                  Start over
                </button>
              </form>
            )}
          </div>

          <p className="mt-[18px] ml-1 text-[12.5px] leading-relaxed text-foreground/80">
            This area is for Inclusion Canada staff. Users don't need an account — the assistant is open to everyone at{" "}
            <Link to="/" className="font-semibold text-primary underline underline-offset-2">
              knowledgecompass.ca
            </Link>
            .
          </p>
        </div>
      </main>
    </div>
  );
}
