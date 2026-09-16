import { useState, useEffect } from "react";
import { useNavigate, useLocation, Link } from "react-router";
import { confirmSignIn } from "aws-amplify/auth";
import { AuthService } from "@/functions/authService";
import BrandMark from "@/components/BrandMark";
import { isDemoMode } from "@/lib/demo";

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
  const [requiresNewPassword, setRequiresNewPassword] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as any)?.from?.pathname || "/admin/dashboard";

  useEffect(() => {
    if (isDemoMode) return;

    const checkAuthStatus = async () => {
      try {
        const session = await AuthService.getAuthSession(true);
        if (session?.tokens?.accessToken) {
          navigate(from, { replace: true });
        }
      } catch {
        console.log("Not authenticated");
      }
    };

    checkAuthStatus();
  }, [navigate, from]);

  const updateAdminUser = async (adminEmail: string) => {
    const token = await AuthService.getAdminIdToken(false);

    const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/admin/promote_user`, {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: adminEmail,
        role: "admin",
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to update admin user: ${res.status} ${text}`);
    }

    return res.json();
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

      if (result.isSignedIn) {
        AuthService.clearAuthCache();
        await updateAdminUser(email);
        setSignedIn(true);
        navigate(from, { replace: true });
      } else if (
        result.nextStep?.signInStep ===
        "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED"
      ) {
        setRequiresNewPassword(true);
      }
    } catch (err: any) {
      setError(err.message || "Invalid email or password");
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

      if (user.isSignedIn) {
        AuthService.clearAuthCache();
        await updateAdminUser(email);
        setSignedIn(true);
        navigate(from, { replace: true });
      }
    } catch (err: any) {
      setError(err.message || "Failed to set new password");
    } finally {
      setIsLoading(false);
    }
  };

  const ready = Boolean(email.trim() && password && !isLoading);
  const newPasswordReady = Boolean(
    newPassword && confirmPassword && !isLoading
  );

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
              {requiresNewPassword ? "Set a new password" : "Sign in"}
            </h1>
            <p className="mt-2 text-[15px] leading-relaxed text-foreground/80">
              {requiresNewPassword
                ? "Please set a new password for your account."
                : isDemoMode
                  ? "Local demo — any complete email and password will open the console."
                  : "Manage the knowledge base, conversation prompts, and detective settings."}
            </p>

            {error ? (
              <div className="mt-5 rounded-[9px] border border-[oklch(0.82_0.08_25)] bg-[oklch(0.96_0.03_25)] px-3.5 py-3 text-sm leading-relaxed text-[oklch(0.38_0.13_25)]">
                {error}
              </div>
            ) : null}

            {signedIn ? (
              <div className="mt-5 rounded-[9px] border border-[oklch(0.80_0.07_160)] bg-[oklch(0.96_0.03_160)] px-3.5 py-3 text-sm leading-relaxed text-[oklch(0.35_0.09_160)]">
                Signed in. Opening the admin dashboard…
              </div>
            ) : null}

            {!requiresNewPassword ? (
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
            ) : (
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
            )}
          </div>

          <p className="mt-[18px] ml-1 text-[12.5px] leading-relaxed text-foreground/80">
            This area is for Inclusion Canada staff. Families don't need an account — the assistant is open to everyone at{" "}
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
