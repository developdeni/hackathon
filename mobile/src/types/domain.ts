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

export type SharePermission = 'view' | 'ai' | 'edit' | 'inspect';
export type ProfileRole = 'owner' | 'member';

export type FarmProfile = {
  id: string;
  name: string;
  region: string;
  createdAt: string;
  fieldCount: number;
  // Командный доступ: своя роль в этом профиле и набор прав.
  role?: ProfileRole;
  permissions?: SharePermission[];
  shareId?: string;
  ownerName?: string;
  fieldScope?: 'all' | 'selected';
};

// Доступ / приглашение в командный профиль.
export type ProfileShare = {
  id: string;
  profileId: string;
  ownerId: string;
  granteeId: string;
  permissions: SharePermission[];
  fieldScope: 'all' | 'selected';
  fieldIds: string[];
  status: 'pending' | 'active' | 'declined' | 'revoked';
  createdAt: string;
  updatedAt: string;
  ownerName: string;
  ownerPublicId?: string | null;
  granteeName: string;
  granteePublicId?: string | null;
  granteeEmail: string;
  profileName: string;
  isOwnerView: boolean;
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
  telegramLinked?: boolean;
  emailVerified?: boolean;
  publicId?: string;
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
  periodEnd?: string;
  validPixelCount?: number;
  phase?: string;
  ndviMean: number;
  ndviMedian: number | null;
  ndmiMean: number | null;
  cloudCoveragePercent: number | null;
  clearPixelPercent?: number | null;
  reliability?: 'high' | 'medium' | 'low' | 'unknown';
  ndviSpread?: number | null;
  anomalyDetected: boolean;
  anomalyFactor?: string;
};

export type SatelliteData = {
  stale?: boolean;
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
  ndmiDeficit: number | null;
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
    estimatedSeasonSavingsKzt: number | null;
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
  stale?: boolean;
  observationDate?: string;
  periodEnd?: string;
  coveragePercent?: number;
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
  qualityScore: number;
  qualityScoreBasis: string;
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
  message?: string;
  observedAt?: string;
  forecastStart?: string;
  forecastEnd?: string;
  status: string;
  source: string;
  coordinates: Coordinate;
  updatedAt: string | null;
  current: {
    temperature: number | null;
    humidity: number | null;
    windSpeed: number | null;
  };
  forecast7d: {
    maxTemp: number | null;
    minTemp: number | null;
    precipSum: number | null;
    evapotranspiration: number | null;
    gddSum?: number | null;
    waterBalance?: number | null;
  };
  alerts: AgroAlert[];
};

export type AiDiagnosisCategory = 'disease' | 'pest' | 'weed' | 'healthy' | 'none';

export type AiDiagnosisResult = {
  detected: boolean;
  category?: AiDiagnosisCategory;
  object_name?: string;
  crop: string;
  diagnosis: string;
  pathogen: string;
  severity: 'low' | 'moderate' | 'high';
  confidence: number | null;
  affected_area_percent: number | null;
  metric_basis?: 'visual_model_interpretation' | 'unavailable' | string;
  description?: string;
  recommendation: string;
  chemicals: string;
  rate: string;
  weather_limits: string;
  yield_loss: string;
};

export type StandRating = 'sparse' | 'optimal' | 'dense' | 'none';

export type AiStandCountResult = {
  detected: boolean;
  is_field: boolean;
  shot_type: 'ground' | 'drone' | '—' | string;
  crop: string;
  plant_count: number;
  frame_area_m2: number | null;
  density_per_m2: number | null;
  density_per_ha: number | null;
  optimal_range_m2: string;
  stand_rating: StandRating;
  uniformity: 'low' | 'moderate' | 'high' | '—' | string;
  gap_percent: number | null;
  confidence: number | null;
  measurement_basis: 'user_calibrated_area' | 'visual_count_unscaled' | 'unavailable' | string;
  assessment: string;
  recommendation: string;
};

export type GrainQualityRating = 'good' | 'acceptable' | 'poor' | 'none';

export type AiGrainQualityResult = {
  detected: boolean;
  is_grain: boolean;
  crop: string;
  grain_count: number;
  sound_percent: number | null;
  weed_impurity_percent: number | null;
  grain_impurity_percent: number | null;
  broken_percent: number | null;
  damaged_percent: number | null;
  grade: string;
  quality_rating: GrainQualityRating;
  confidence: number | null;
  measurement_basis: 'visual_area_estimate' | 'unavailable' | string;
  laboratory_grade_available: boolean;
  assessment: string;
  recommendation: string;
};

export type LivestockSpecies = {
  name: string;
  name_en: string;
  count: number;
};

export type AiLivestockResult = {
  detected: boolean;
  is_livestock: boolean;
  shot_type: 'ground' | 'drone' | '—' | string;
  total_count: number;
  species: LivestockSpecies[];
  dominant_species: string;
  crowding: 'low' | 'moderate' | 'high' | '—' | string;
  confidence: number | null;
  measurement_basis: 'visual_model_count' | 'unavailable' | string;
  count_method: 'enumerated' | 'dense_estimate' | 'unavailable' | string;
  count_range: string;
  assessment: string;
  recommendation: string;
};

export type ClimateRiskLevel = 'low' | 'moderate' | 'high';

export type ClimateRiskDecade = {
  label: string;
  period: string;
  is_past: boolean;
  days_count: number;
  overall_index: number;
  overall_level: ClimateRiskLevel;
  drought_index: number;
  sukhovey_index: number;
  early_snow_index: number;
  mean_tmax: number;
  min_tmin: number;
  precip_sum: number;
  factors: string[];
};

export type ClimateRiskAlert = {
  type: 'drought' | 'sukhovey' | 'early_snow' | string;
  level: 'warning' | 'critical';
  title: string;
  description: string;
};

export type ClimateRiskForecast = {
  available: boolean;
  source: string;
  generated_at?: string;
  decades: ClimateRiskDecade[];
  alerts: ClimateRiskAlert[];
  summary: string;
};

export type YieldHistorySource = 'farm_record' | 'partner' | 'official_stat';

export type YieldHistoryRecord = {
  id: string;
  fieldId: string;
  seasonYear: number;
  cropType: string;
  yieldTPerHa: number;
  source: YieldHistorySource;
  notes: string;
  createdAt: string;
};

export type YieldForecastFactor = {
  id: string;
  label: string;
  detail: string;
  value: number;
  contributionTPerHa: number;
  direction: 'positive' | 'negative' | 'neutral';
};

export type YieldForecastSource = {
  id: string;
  name: string;
  status: 'connected' | 'unavailable' | 'reference_only' | 'farm_records_only' | string;
  role: string;
};

export type YieldForecast = {
  stale?: boolean;
  status: 'ready' | 'insufficient_data' | 'unavailable';
  fieldId: string;
  cropType: string;
  seasonYear: number;
  generatedAt: string;
  forecastTPerHa: number | null;
  interval80: { low: number; high: number } | null;
  confidenceLevel: number;
  modelQuality: 'preliminary' | 'medium' | 'high' | 'unavailable';
  historyCount: number;
  requiredHistoryCount: number;
  method: string;
  message: string;
  missingData: string[];
  validationMaeTPerHa?: number;
  factors: YieldForecastFactor[];
  inputs: Record<string, number | string> | null;
  sources: YieldForecastSource[];
};

export type OperationWindow = {
  start: string;
  end: string;
  score: number;
  confidence: 'higher' | 'medium' | 'lower';
  factors: string[];
  risks: string[];
  metrics: {
    precipSum: number;
    minTemperature: number;
    maxWind: number;
    soilTemperature: number | null;
    soilMoisture: number | null;
  };
};

export type FieldOperationRecommendation = {
  type: 'sowing' | 'harvest';
  title: string;
  status: 'recommended' | 'watch' | 'verify_field' | 'no_window' | 'out_of_season';
  calendar: string;
  summary: string;
  windows: OperationWindow[];
};

export type FieldOperationsRecommendation = {
  stale?: boolean;
  status: 'ready' | 'unavailable';
  fieldId: string;
  cropType: string;
  cropProfile?: string;
  generatedAt: string;
  horizonStart: string | null;
  horizonEnd: string | null;
  fieldState: {
    status: 'maturing' | 'approaching' | 'vegetating' | 'unknown';
    label: string;
    message: string;
    latestNdvi: number | null;
    peakNdvi: number | null;
    declineFromPeak: number | null;
    observationDate: string | null;
  };
  operations: FieldOperationRecommendation[];
  source: string;
  message: string;
};

export type AiChatMessage = {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  timestamp: string;
  diagnosis?: AiDiagnosisResult | null;
  photoUri?: string | null;
};

export type AiFieldBadge = {
  label: string;
  type: 'success' | 'warning' | 'info' | 'primary';
  detail?: string;
};

export type AiFarmSummary = {
  status: 'ready' | 'empty';
  profileId: string;
  farmName: string;
  region?: string;
  totalAreaHa: number;
  fieldsCount: number;
  cropsSummary: string;
  summaryText: string;
  quickQuestions: string[];
  fieldBadges: Record<string, AiFieldBadge>;
  generatedAt?: string;
};
