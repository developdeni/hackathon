export type Coordinate = {
  latitude: number;
  longitude: number;
};

export type Field = {
  id: string;
  name: string;
  cropType: string;
  areaHa: number;
  boundary: Coordinate[];
  isDemo: boolean;
  inspectionCount: number;
};

export type Inspection = {
  id: string;
  fieldId: string;
  createdAt: string;
  note: string;
  photoUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  status: 'saved';
};

export type ServerHealth = {
  status: 'ok';
  database: 'connected';
  time: string;
};
