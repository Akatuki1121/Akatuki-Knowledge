-- Remove the historical task-count ceiling and align the Workflow-step constraint
-- with the application admission budget (2,700 of the 3,000 Free steps/day).
CREATE TABLE agent_task_daily_budget_new (
    budget_day TEXT PRIMARY KEY,
    tasks_reserved INTEGER NOT NULL DEFAULT 0 CHECK (tasks_reserved >= 0),
    workflow_steps_reserved INTEGER NOT NULL DEFAULT 0 CHECK (workflow_steps_reserved BETWEEN 0 AND 2700),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO agent_task_daily_budget_new (budget_day, tasks_reserved, workflow_steps_reserved, updated_at)
SELECT budget_day, tasks_reserved, workflow_steps_reserved, updated_at
FROM agent_task_daily_budget;

DROP TABLE agent_task_daily_budget;
ALTER TABLE agent_task_daily_budget_new RENAME TO agent_task_daily_budget;
