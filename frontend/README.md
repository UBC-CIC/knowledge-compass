# Knowledge Compass — Frontend

React 19 + TypeScript single-page app built with Vite and Tailwind CSS. It serves the public chat (`/`, `/chat`) and the admin dashboard (`/admin`, sign-in at `/admin/login`). AWS Amplify Hosting builds and serves it (`cdk/lib/amplify-stack.ts`).

## Environment

Amplify sets these at build time from the deployed stacks. For local development, put them in `frontend/.env.local` (ignored by git):

| Variable | Value |
|---|---|
| `VITE_API_ENDPOINT` | REST API base URL |
| `VITE_WEBSOCKET_URL` | WebSocket URL including the stage |
| `VITE_COGNITO_USER_POOL_ID` | Admin Cognito user pool |
| `VITE_COGNITO_USER_POOL_CLIENT_ID` | Admin user pool app client |
| `VITE_DEMO_MODE` | Optional. `true` shows scripted demo chats and admin data instead of calling the backend (`src/lib/demo.ts`) |

The deployed API only accepts requests from origins listed in `/KC/API/AllowedOrigins` (see the [Deployment Guide](../Docs/DEPLOYMENT_GUIDE.md#adding-custom-allowed-origins)).

## Commands

```bash
npm install
npm run dev       # Vite dev server
npm run build     # type-check and production build
npm run lint      # ESLint
npm test          # Vitest
npm run preview   # serve the production build
```

## Layout

| Path | Contents |
|---|---|
| `src/pages/` | Route pages: `HomePage`, `Admin/AdminDashboard`, `Admin/AdminLogin` |
| `src/components/ChatInterface/` | Chat UI |
| `src/components/Admin/` | Dashboard sections: data sources, search index (embeddings), prompts, guidelines, settings, analytics, feedback |
| `src/components/ui/` | shadcn/ui components |
| `src/providers/` | React context (`UserContext`, `ViewContext`, `SidebarContext`) |
| `src/lib/` | API client, public token handling, demo mode and helpers |
