import { BrowserRouter, Routes, Route } from "react-router";
import AppLayout from "./layouts/AppLayout";
import { UserProvider } from "./providers/UserContext";
import HomePage from "./pages/HomePage";
import AdminLogin from "./pages/Admin/AdminLogin";
import AdminDashboard from "./pages/Admin/AdminDashboard";
import ProtectedRoute from "./components/ProtectedRoute";
import { Amplify } from "aws-amplify";

try {
  Amplify.configure({
    API: {
      REST: {
        MyApi: {
          endpoint: import.meta.env.VITE_API_ENDPOINT || "http://localhost",
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
