const assignees = require('./assignees.json');
const axios = require('axios');
require('dotenv').config();
const ELASTICSEARCH_URL = process.env.ES_URL;
const JIRA_BASE_URL = process.env.JIRA_URL;
const JIRA_API_TOKEN = process.env.JIRA_TOKEN ? process.env.JIRA_TOKEN.replace(/[\n\r]/g, '').trim() : '';
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY;
const BOARD_ID = process.env.JIRA_PROJECT_BOARD_ID;
const JIRA_USER_DOMAIN = process.env.JIRA_USER_DOMAIN;
const RESULTS_DASHBOARD_ELASTICSEARCH_URL = process.env.RESULT_DASHBOARD_ES_URL;
const QUERY = {
  size: 10000,
  query: {
    bool: {
      must: [
        {
          range: {
            uploaded: {
              gte: 'now-7d/d',
              lt: 'now/d'
            }
          }
        },
        {
          term: {
            'result.keyword': 'FAIL'
          }
        }
      ]
    }
  }
};

const RP_QUERY = {
  size: 10000,
  query: {
    bool: {
      must: [
        {
          range: {
            date: {
              gte: 'now-7d/d',
              lt: 'now/d'
            }
          }
        }
      ]
    }
  }
}

async function updateIssueWithStoryPoints(issueKey) {
  const url = `${JIRA_BASE_URL}/rest/api/2/issue/${issueKey}`;
  const data = {
    fields: {
      'customfield_12310243': 1
    }
  };

  try {
    const response = await axios.put(url, data, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${JIRA_API_TOKEN}`,
      },
    });
    console.log('Issue updated with story points successfully');
  } catch (error) {
    console.error('Error updating issue with story points:', error.response ? error.response.data : error.message);
  }
}
async function addIssueToSprint(issueKey, sprintId) {

  try {
    await axios.post(`${JIRA_BASE_URL}/rest/agile/1.0/sprint/${sprintId}/issue`, {
      issues: [issueKey]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${JIRA_API_TOKEN}`,
      },
    });

    console.log(`Added issue ${issueKey} to sprint ${sprintId}`);
  } catch (error) {
    console.error('Error adding issue to sprint:', error.response.data);
  }
}

async function fetchSprints() {
  try {
    const response = await axios.get(`${JIRA_BASE_URL}/rest/agile/1.0/board/${BOARD_ID}/sprint`, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${JIRA_API_TOKEN}`,
      },
    });

    const sprints = response.data.values;

    const activeSprint = sprints.find(sprint => sprint.state === 'active');
    return activeSprint.id
  } catch (error) {
    console.error('Error fetching sprints:', error.response.data);
  }
};

const createJIRAIssue = async (issueData) => {
  const response = await axios.post(`${JIRA_BASE_URL}/rest/api/2/issue`, issueData, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${JIRA_API_TOKEN}`,
    },
  });
  const issueKey = response.data.key;
  console.log(`Created issue: ${issueKey}`);
  const sprint_id = await fetchSprints();
  await addIssueToSprint(issueKey, sprint_id);
  await updateIssueWithStoryPoints(issueKey)
}

async function fetchData() {
  try {
    const response = await axios.get(ELASTICSEARCH_URL, {
      headers: { 'Content-Type': 'application/json' },
      data: QUERY
    });


    const results = response.data.hits.hits.map(hit => hit._source);
    const response_rp = await axios.get(RESULTS_DASHBOARD_ELASTICSEARCH_URL, {
      headers: { 'Content-Type': 'application/json' },
      data: RP_QUERY
    })

    const results_rp = response_rp.data.hits.hits
    const url_pass_fail_map = new Map();
    results_rp.forEach(result_rp => {
      url_pass_fail_map.set(result_rp._source.link, result_rp._source.result)
    });
    const resultMap = new Map();
    const numberMap = new Map();
    results.forEach(result => {
      if (url_pass_fail_map.get(result.build_url) === 'FAIL') {
        let key = result.job_name.substring(8);
        lastIndex = key.lastIndexOf('_');
        key = key.substring(0, lastIndex);
        if (!resultMap.has(key)) {
          resultMap.set(key, ["*"])
        }
        lastSlash = result.build_url.lastIndexOf("/")
        secondLastSlash = result.build_url.lastIndexOf("/", lastSlash - 1)
        runNumber = result.build_url.substring(secondLastSlash + 1, lastSlash)
        if (!(resultMap.get(key).includes(runNumber)))
          resultMap.get(key).unshift(runNumber)
        if (!(resultMap.get(key).includes(result.description))) {
          resultMap.get(key).push(result.description);
          numberMap.set(key + "_" + result.description, 1)
        }
        else {
          val = numberMap.get(key + "_" + result.description)
          numberMap.set(key + "_" + result.description, val + 1)
        }
      }
    });

    return { resultMap, numberMap };
  } catch (error) {
    console.error('Error fetching data:', error);
  }
}


const main = async () => {
  const { resultMap, numberMap } = await fetchData();
  resultMap.forEach((value, key) => {
    let numberOfFails = value.indexOf('*')
    let runNumbers = value.slice(0, value.indexOf('*'))
    let reasonOfFailue = value.indexOf('*') !== -1 ? value.slice(value.indexOf('*') + 1) : [];
    if (reasonOfFailue.length > 2)
      trimmedFailureArray = reasonOfFailue.slice(0, 2)
    else
      trimmedFailureArray = reasonOfFailue
    const statement = `${key}: ${numberOfFails} ${numberOfFails == 1 ? 'run' : 'runs'} failing due to ${trimmedFailureArray} ${reasonOfFailue.length > 2 ? `and ${reasonOfFailue.length - 2} more ${reasonOfFailue.length - 2 > 1 ? 'parameters' : 'parameter'}` : ''} going out of bounds`
    let shortDescription = '';
    reasonOfFailue.forEach((failure) => {
      let fails = numberMap.get(`${key}_${failure}`)
      shortDescription += `${failure} failed in ${fails} ${fails == 1 ? 'run' : 'runs'} \n`
    })
    const description = `Runs failing : ${runNumbers} \n ${shortDescription}`
    let assignee = assignees.find(assignee => assignee.service === `Insights${key}_runner`);
    assignee = assignee.assignee
    const issueData = {
      fields: {
        project: {
          key: PROJECT_KEY
        },
        summary: statement,
        description: description,
        assignee: {
          name: `${assignee}`
        },
        issuetype: {
          name: 'Task'
        }
      }
    }
    createJIRAIssue(issueData)
  }
  )
};


main()
