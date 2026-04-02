import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import { ModelsList, ModelDetailPage } from './pages/Models'
import { ChannelsList, ChannelDetailPage } from './pages/Channels'
import Sessions from './pages/Sessions'
import SessionDetailPage from './pages/SessionDetail'
import Settings from './pages/Settings'
import ClaudeCode from './pages/ClaudeCode'
import OpenClawOverview from './pages/OpenClawOverview'
import CodexOverview from './pages/CodexOverview'
import { ThemeProvider } from './lib/theme'

export default function App() {
  return (
    <ThemeProvider>
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/platforms/claude-code" element={<ClaudeCode />} />
          <Route path="/platforms/openclaw" element={<OpenClawOverview />} />
          <Route path="/platforms/codex" element={<CodexOverview />} />
          <Route path="/claude-code" element={<ClaudeCode />} />
          <Route path="/openclaw" element={<Navigate to="/platforms/openclaw" replace />} />
          <Route path="/codex" element={<Navigate to="/platforms/codex" replace />} />
          <Route path="/models" element={<ModelsList />} />
          <Route path="/models/:modelId" element={<ModelDetailPage />} />
          <Route path="/channels" element={<ChannelsList />} />
          <Route path="/channels/:channel" element={<ChannelDetailPage />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/sessions/:id" element={<SessionDetailPage />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </Layout>
    </BrowserRouter>
    </ThemeProvider>
  )
}
