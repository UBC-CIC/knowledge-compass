import { BrowserRouter, Routes, Route } from "react-router";
import AppLayout from "./layouts/AppLayout";
import { UserProvider } from "./providers/UserContext";
import HomePage from "./pages/HomePage";
import AdminLogin from "./pages/Admin/AdminLogin";
import AdminDashboard from "./pages/Admin/AdminDashboard";
import ProtectedRoute from "./components/ProtectedRoute";
import { Amplify } from "aws-amplify";
import { API_ENDPOINT } from "@/lib/api";
import { restoreAdminTokenStorage } from "@/lib/adminTokenStorage";

try {
  Amplify.configure({
    API: {
      REST: {
        MyApi: {
          endpoint: API_ENDPOINT || "http://localhost",
        },
      },
    },
    Auth: {
      Cognito: {
        userPoolClientId:
          import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID || "demo-client",
        userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID || "us-east-1_demo",
      },
    },
  });
  // After configure, which resets the token store to localStorage.
  restoreAdminTokenStorage();
} catch (error) {
  console.warn("[App] Amplify configure skipped:", error);
}





function App() {
  return (
    <BrowserRouter>
      <UserProvider>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/chat" element={<HomePage />} />

            {/* Admin Routes */}
            <Route path="/admin/login" element={<AdminLogin />} />
            <Route
              path="/admin/dashboard"
              element={
                <ProtectedRoute>
                  <AdminDashboard />
                </ProtectedRoute>
              }
            />
          </Route>
        </Routes>
      </UserProvider>
    </BrowserRouter>
  );
}

export default App;
