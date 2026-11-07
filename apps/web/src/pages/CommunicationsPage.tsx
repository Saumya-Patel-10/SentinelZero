import React from 'react';
import { IncidentChat } from '../components/communications/IncidentChat';

export const CommunicationsPage: React.FC = () => {
  return (
    <div className="space-y-4 animate-fade-in">
      <div>
        <h2 className="text-xl font-bold text-slate-100">Out-of-Band Incident Communications</h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Dedicated crisis coordination channel operating independently of compromised corporate mail and active directory.
        </p>
      </div>
      <IncidentChat />
    </div>
  );
};
