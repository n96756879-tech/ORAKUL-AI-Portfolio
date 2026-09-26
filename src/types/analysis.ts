export interface ProbabilityMarket {
  label: string;
  value: string;
}

export interface AnalysisSource {
  title: string;
  url: string;
}

export interface AnalysisExplanation {
  overview: string;
  team1Form: string;
  team2Form: string;
  h2h: string;
  squadAndInjuries: string;
  factors: string;
}

export interface AnalysisResult {
  status: 'success';
  match: {
    title: string;
    meta?: string;
  };
  probabilities: {
    outcomes: ProbabilityMarket[];
  };
  explanation: AnalysisExplanation;
  usedSources: AnalysisSource[];
}

export interface AnalysisErrorResponse {
  error: string;
}

export type AnalyzeApiResponse = AnalysisResult | AnalysisErrorResponse;
