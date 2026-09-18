export type Coordinate = {
  latitude: number;
  longitude: number;
};

export type Field = {
  id: string;
  profileId: string;
  name: string;
  cropType: string;
  areaHa: number;
  perimeterKm: number;
  boundary: Coordinate[];
  isDemo: boolean;
  inspectionCount: number;
};

export type FarmProfile = {
  id: string;
  name: string;
  region: string;
  createdAt: string;
  fieldCount: number;
};

export type CreateProfileInput = {
  name: string;
  region: string;
};

export type CreateFieldInput = {
  profileId: string;
  name: string;
  cropType: string;
  areaHa?: number; // optional — server computes from boundary if omitted
  boundary: Coordinate[];
};

export type Inspection = {
  id: string;
  fieldId: string;
  createdAt: string;
  note: string;
  photoUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  status: 'saved' | 'pending';
};

export type ServerHealth = {
  status: 'ok';
  database: 'connected';
  time: string;
};

// ---------------------------------------------------------------------------
// Auth types
// ---------------------------------------------------------------------------

export type User = {
  id: string;
  name: string;
  email: string;
  organization: string;
  region: string;
  createdAt: string;
  stats?: {
    fieldCount: number;
    inspectionCount: number;
    totalAreaHa: number;
    profileCount: number;
  };
};

export type AuthResponse = {
  token: string;
  user: User;
};

export type LoginInput = {
  email: string;
  password: string;
};

export type RegisterInput = {
  name: string;
  email: string;
  password: string;
  organization?: string;
  region?: string;
};

// ---------------------------------------------------------------------------
// Satellite / analytics types (unchanged)
// ---------------------------------------------------------------------------

export type SatelliteObservation = {
  date: string;
  phase?: string;
  ndviMean: number;
  ndviMedian: number;
  ndmiMean: number | null;
  cloudCoveragePercent: number;
  anomalyDetected: boolean;
  anomalyFactor?: string;
};

export type SatelliteData = {
  fieldId: string;
  status: 'ready' | 'pending';
  message?: string;
  source: string;
  mission: string;
  spatialResolutionMeters: number;
  cloudMaskingMethod: string;
  updatedAt: string;
  periodStart?: string;
  periodEnd?: string;
  observationCount?: number;
  observations: SatelliteObservation[];
};

export type RiskZone = {
  id: string;
  priority: number;
  severity: 'critical' | 'moderate' | 'low';
  title: string;
  analysisDate?: string;
  areaHa: number;
  percentOfField: number;
  persistenceDays: number;
  persistenceStatus: string;
  ndviMean?: number;
  ndviDeficit: number;
  ndmiDeficit: number;
  mainFactor: string;
  recommendation: string;
  centroid: Coordinate;
  boundary: Coordinate[];
  fillColor: string;
  strokeColor: string;
};

export type BenchmarkData = {
  economicScouting: {
    fieldAreaHa: number;
    targetInspectionHa: number;
    savedInspectionHa: number;
    reductionPercent: number;
    estimatedSeasonSavingsKzt: number;
  };
};

export type NdviCell = {
  id: string;
  ndvi: number;
  ndmi: number | null;
  boundary: Coordinate[];
  centroid: Coordinate;
  color: string;
};

export type ZonesData = {
  fieldId: string;
  fieldName: string;
  totalFieldAreaHa: number;
  status: 'ready' | 'pending';
  message?: string;
  analysisDate: string;
  analysisDaysAgo?: number;
  satelliteMission: string;
  dataSource?: string;
  meanFieldNdvi?: number | null;
  meanFieldNdmi?: number | null;
  zonesCount: number;
  totalSuspectAreaHa: number;
  zones: RiskZone[];
  benchmark: BenchmarkData | null;
  ndviGrid: NdviCell[];
  ndviRange: { min: number; max: number } | null;
};

export type LandUseClassification = {
  fieldId: string;
  status: 'active' | 'fallow' | 'uncertain' | 'unknown';
  label: string;
  description: string;
  maxNdvi: number | null;
  minNdvi: number | null;
  amplitude: number | null;
  rule: string;
  source?: string;
};

export type AutoBoundaryResult = {
  status: 'ready';
  method: string;
  confidence: number;
  source: string;
  spatialResolutionMeters: number;
  analysisWindowDays: number;
  seedNdvi: number;
  coveragePercent: number;
  estimatedAreaHa: number;
  compactness: number;
  pointCount: number;
  needsReview: boolean;
  warning?: string | null;
  boundary: Coordinate[];
};

export type AgroAlert = {
  type: 'frost' | 'dry_wind' | 'moisture_deficit';
  level: 'critical' | 'warning' | 'moderate';
  title: string;
  description: string;
};

export type AgroWeather = {
  status: string;
  source: string;
  coordinates: Coordinate;
  updatedAt: string;
  current: {
    temperature: number;
    humidity: number;
    windSpeed: number;
  };
  forecast7d: {
    maxTemp: number;
    minTemp: number;
    precipSum: number;
    evapotranspiration: number;
    gddSum?: number;
  };
  alerts: AgroAlert[];
};

export type AiDiagnosisResult = {
  detected: boolean;
  crop: string;
  diagnosis: string;
  pathogen: string;
  severity: 'low' | 'moderate' | 'high';
  confidence: number;
  affected_area_percent: number;
  description?: string;
  recommendation: string;
  chemicals: string;
  rate: string;
  weather_limits: string;
  yield_loss: string;
};

export type AiChatMessage = {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  timestamp: string;
  diagnosis?: AiDiagnosisResult | null;
  photoUri?: string | null;
};
