/**
 * Linear GraphQL Queries for Symphony
 */

export const FETCH_CANDIDATE_ISSUES = `
  query FetchCandidateIssues($projectSlug: String!, $states: [String!]!, $after: String) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $states } }
      }
      first: 50
      after: $after
      orderBy: createdAt
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        identifier
        title
        description
        priority
        branchName
        url
        createdAt
        updatedAt
        state {
          id
          name
          type
        }
        labels {
          nodes {
            id
            name
          }
        }
        inverseRelations {
          nodes {
            type
            issue {
              id
              identifier
              state {
                name
              }
            }
          }
        }
        children {
          nodes {
            id
            identifier
            title
            description
            priority
            subIssueSortOrder
            createdAt
            updatedAt
            state {
              id
              name
              type
            }
            assignee {
              id
              name
            }
          }
        }
        comments(first: 20, orderBy: createdAt) {
          nodes {
            id
            body
            createdAt
            user { name }
          }
        }
      }
    }
  }
`;

export const FETCH_ISSUES_BY_IDS = `
  query FetchIssuesByIds($ids: [ID!]!) {
    issues(filter: { id: { in: $ids } }) {
      nodes {
        id
        state {
          name
        }
      }
    }
  }
`;

export const FETCH_ISSUES_BY_STATES = `
  query FetchIssuesByStates($projectSlug: String!, $states: [String!]!, $after: String) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $states } }
      }
      first: 50
      after: $after
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        identifier
        title
        description
        priority
        branchName
        url
        createdAt
        updatedAt
        state {
          id
          name
          type
        }
        labels {
          nodes {
            id
            name
          }
        }
        inverseRelations {
          nodes {
            type
            issue {
              id
              identifier
              state {
                name
              }
            }
          }
        }
      }
    }
  }
`;

export const EXECUTE_GRAPHQL = `
  # Dynamic query - passed through from linear_graphql tool
`;

// ── CRUD Operations (used by linear CLI) ────────────────────────

export const GET_ISSUE = `
  query GetIssue($identifier: String!) {
    issue(id: $identifier) {
      id
      identifier
      title
      description
      state { id name type }
      team { id }
      labels { nodes { id name } }
      children {
        nodes {
          id identifier title description priority
          subIssueSortOrder
          state { id name type }
        }
      }
      comments(first: 20, orderBy: createdAt) {
        nodes {
          id
          body
          createdAt
          user { name }
        }
      }
    }
  }
`;

export const GET_COMMENTS = `
  query GetComments($issueId: String!) {
    issue(id: $issueId) {
      comments(first: 50, orderBy: createdAt) {
        nodes {
          id
          body
          createdAt
          user { name }
        }
      }
    }
  }
`;

export const CREATE_ISSUE = `
  mutation CreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id identifier title url }
    }
  }
`;

export const UPDATE_ISSUE = `
  mutation UpdateIssue($issueId: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $issueId, input: $input) {
      success
    }
  }
`;

export const CREATE_COMMENT = `
  mutation CreateComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment { id }
    }
  }
`;

export const GET_ISSUE_LABELS = `
  query GetIssueLabels($issueId: String!) {
    issue(id: $issueId) {
      labels { nodes { id name } }
    }
  }
`;

export const FIND_STATE_ID = `
  query GetStates($teamId: String!) {
    team(id: $teamId) {
      states { nodes { id name } }
    }
  }
`;

export const GET_TEAM_LABELS = `
  query GetTeamLabels($teamId: String!) {
    team(id: $teamId) {
      labels { nodes { id name color } }
    }
  }
`;

export const UPDATE_COMMENT = `
  mutation UpdateComment($commentId: String!, $body: String!) {
    commentUpdate(id: $commentId, input: { body: $body }) {
      success
    }
  }
`;

export const CREATE_LABEL = `
  mutation CreateLabel($input: IssueLabelCreateInput!) {
    issueLabelCreate(input: $input) {
      success
      issueLabel { id name }
    }
  }
`;

export const GET_ISSUE_ATTACHMENTS = `
  query GetIssueAttachments($issueId: String!) {
    issue(id: $issueId) {
      attachments {
        nodes {
          id
          title
          url
        }
      }
    }
  }
`;
