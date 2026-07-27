import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "./pages/NotFound";
import { HackathonLayout } from "@/hackathon/HackathonLayout";
import HackathonIndex from "@/hackathon/pages/HackathonIndex";
import LiveEvent from "@/hackathon/pages/LiveEvent";
import Submissions from "@/hackathon/pages/Submissions";
import AgentPipeline from "@/hackathon/pages/AgentPipeline";
import CreateHackathon from "@/hackathon/pages/CreateHackathon";
import SubmitProject from "@/hackathon/pages/SubmitProject";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HackathonLayout><HackathonIndex /></HackathonLayout>} />
          <Route path="/hackathon" element={<HackathonLayout><HackathonIndex /></HackathonLayout>} />
          <Route path="/hackathon/live" element={<HackathonLayout><LiveEvent /></HackathonLayout>} />
          <Route path="/hackathon/submit" element={<HackathonLayout><SubmitProject /></HackathonLayout>} />
          <Route path="/hackathon/submissions" element={<HackathonLayout><Submissions /></HackathonLayout>} />
          <Route path="/hackathon/agents" element={<HackathonLayout><AgentPipeline /></HackathonLayout>} />
          <Route path="/hackathon/create" element={<HackathonLayout><CreateHackathon /></HackathonLayout>} />
          <Route path="/create" element={<Navigate to="/hackathon/create" replace />} />
          <Route path="/tasks" element={<Navigate to="/hackathon/submissions" replace />} />
          <Route path="/agents" element={<Navigate to="/hackathon/agents" replace />} />
          <Route path="/task/:id" element={<Navigate to="/hackathon/submissions" replace />} />
          <Route path="*" element={<HackathonLayout><NotFound /></HackathonLayout>} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
