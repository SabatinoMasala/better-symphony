/**
 * Linear Tracker Types
 */

export interface RateLimitState {
  requestsLimit: number;
  requestsRemaining: number;
  requestsReset: number;
  complexityLimit: number;
  complexityRemaining: number;
  complexityReset: number;
}

export interface LinearChildIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  subIssueSortOrder: number;
  createdAt: string;
  updatedAt: string;
  state: {
    id: string;
    name: string;
    type: string;
  };
  assignee?: {
    id: string;
    name: string;
  } | null;
}

export interface LinearCommentNode {
  id: string;
  body: string;
  createdAt: string;
  user?: {
    name: string;
  } | null;
}

export interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  branchName: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  state: {
    id: string;
    name: string;
    type: string;
  };
  labels: {
    nodes: Array<{
      id: string;
      name: string;
    }>;
  };
  relations?: {
    nodes: Array<{
      type: string;
      relatedIssue: {
        id: string;
        identifier: string;
        state: {
          name: string;
        };
      };
    }>;
  };
  inverseRelations?: {
    nodes: Array<{
      type: string;
      issue: {
        id: string;
        identifier: string;
        state: {
          name: string;
        };
      };
    }>;
  };
  children?: {
    nodes: LinearChildIssueNode[];
  };
  comments?: {
    nodes: LinearCommentNode[];
  };
}

export interface LinearIssuesData {
  issues: {
    nodes: LinearIssueNode[];
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  };
}

export interface LinearIssueStatesData {
  issues: {
    nodes: Array<{
      id: string;
      state: {
        name: string;
      };
    }>;
  };
}

export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{
    message: string;
    extensions?: {
      code?: string;
    };
  }>;
}
