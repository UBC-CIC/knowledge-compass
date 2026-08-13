import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { confirmSignIn } from "aws-amplify/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthService } from "@/functions/authService";
import Footer from "@/components/Footer";

type View = "signIn" | "newPassword" | "signUp" | "signUpSuccess";

export default function LandingPage() {
  const navigate = useNavigate();
  const [view, setView] = useState<View>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    AuthService.getAuthSession(true)
      .then((session) => {
        if (session?.tokens?.accessToken) navigate("/", { replace: true });
      })
      .catch(() => {});
  }, [navigate]);

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const result = await AuthService.signIn(email, password);
    setLoading(false);
    if (!result.success) {
      setError(result.error || "Sign-in failed.");
      return;
    }
    if (result.nextStep?.signInStep === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED") {
      setView("newPassword");
      return;
    }
    if (result.isSignedIn) {
      navigate("/", { replace: true });
    }
  }

  async function handleNewPassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (newPassword !== confirmNewPassword) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      const { isSignedIn } = await confirmSignIn({ challengeResponse: newPassword });
      AuthService.clearAuthCache();
      if (isSignedIn) navigate("/", { replace: true });
    } catch (err: any) {
      setError(err.message || "Failed to set password.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Sign-up failed.");
        return;
      }
      setView("signUpSuccess");
    } catch (err: any) {
      setError(err.message || "Sign-up failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-gray-900">Knowledge Bridge</h1>
          </div>

          {view === "signIn" && (
            <form onSubmit={handleSignIn} className="space-y-4">
              <div>
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </div>
              <div>
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Signing in…" : "Sign in"}
              </Button>
              <p className="text-center text-sm text-gray-500">
                Don&apos;t have an account?{" "}
                <button
                  type="button"
                  className="text-blue-600 hover:underline"
                  onClick={() => { setView("signUp"); setError(""); }}
                >
                  Request access
                </button>
              </p>
            </form>
          )}

          {view === "newPassword" && (
            <form onSubmit={handleNewPassword} className="space-y-4">
              <p className="text-sm text-gray-600">
                You must set a new password before continuing.
              </p>
              <div>
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="confirm-password">Confirm new password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Setting password…" : "Set password & sign in"}
              </Button>
            </form>
          )}

          {view === "signUp" && (
            <form onSubmit={handleSignUp} className="space-y-4">
              <p className="text-sm text-gray-600">
                Enter your email. If approved, you&apos;ll receive a temporary password.
              </p>
              <div>
                <Label htmlFor="signup-email">Email</Label>
                <Input
                  id="signup-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Sending…" : "Request access"}
              </Button>
              <p className="text-center text-sm text-gray-500">
                Already have an account?{" "}
                <button
                  type="button"
                  className="text-blue-600 hover:underline"
                  onClick={() => { setView("signIn"); setError(""); }}
                >
                  Sign in
                </button>
              </p>
            </form>
          )}

          {view === "signUpSuccess" && (
            <div className="text-center space-y-4">
              <p className="text-gray-700">
                Check your email for a temporary password, then{" "}
                <button
                  type="button"
                  className="text-blue-600 hover:underline"
                  onClick={() => { setView("signIn"); setError(""); }}
                >
                  sign in
                </button>
                .
              </p>
            </div>
          )}
        </div>
      </div>
      <Footer />
    </div>
  );
}
