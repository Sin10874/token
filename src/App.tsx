import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import { ModelsList, ModelDetailPage } from './pages/Models'
import { ChannelsList, ChannelDetailPage } from './pages/Channels'
import Sessions from './pages/Sessions'
import SessionDetailPage from './pages/SessionDetail'
import Settings from './pages/Settings'

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
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
  )
}
