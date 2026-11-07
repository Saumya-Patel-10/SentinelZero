import { useState, useEffect, useCallback } from 'react';
import { spacetimeClient } from '../services/spacetimeClient';
import { Incident, Asset, OperationalImpact, DataScope, IncidentStatus, VerificationStatus } from '../services/contracts';

export function useIncidents() {
  const [incident, setIncident] = useState<Incident | null>(spacetimeClient.getState().incident);
  const [assets, setAssets] = useState<Asset[]>(spacetimeClient.getState().assets);
  const [impacts, setImpacts] = useState<OperationalImpact[]>(spacetimeClient.getState().impacts);
  const [dataScopes, setDataScopes] = useState<DataScope[]>(spacetimeClient.getState().dataScopes);

  useEffect(() => {
    return spacetimeClient.subscribe((state) => {
      setIncident(state.incident);
      setAssets(state.assets);
      setImpacts(state.impacts);
      setDataScopes(state.dataScopes);
    });
  }, []);

  const transitionStatus = useCallback(async (newStatus: IncidentStatus, explanation?: string) => {
    return await spacetimeClient.transitionIncidentStatus(newStatus, explanation);
  }, []);

  const updateAsset = useCallback(
    async (
      assetId: string,
      updates: { compromise_status?: VerificationStatus; availability_status?: VerificationStatus }
    ) => {
      return await spacetimeClient.updateAssetStatus(assetId, updates);
    },
    []
  );

  const createNewIncident = useCallback(
    async (payload: {
      title: string;
      description: string;
      category: Incident['category'];
      severity: Incident['severity'];
      commander_identity: string;
    }) => {
      return await spacetimeClient.createIncident(payload);
    },
    []
  );

  return {
    incident,
    assets,
    impacts,
    dataScopes,
    transitionStatus,
    updateAsset,
    createNewIncident,
  };
}
