import { useRef, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import wrapAnsi from "wrap-ansi";
import type {
  PlanningAnswers,
  PlanningQuestions as Questions,
} from "../../agent/planning-contracts";
import { terminalText, useTerminalSize } from "../terminal";
import { consoleTheme as palette } from "../../presentation/console-theme";

export function PlanningQuestions({
  request,
  onAnswer,
}: {
  request: Questions;
  onAnswer: (answers?: PlanningAnswers) => void;
}): ReactNode {
  const [number, setNumber] = useState(0);
  const [index, setIndex] = useState(0);
  const [freeText, setFreeText] = useState(false);
  const [value, setValue] = useState("");
  const [offset, setOffset] = useState(0);
  const answers = useRef<PlanningAnswers>({});
  const submitted = useRef(false);
  const { rows, columns } = useTerminalSize();
  const question = request.questions[number];
  const options = [...(question.options ?? [])].sort(
    (a, b) => Number(b.recommended) - Number(a.recommended),
  );
  const editing = freeText || !options.length;
  const description = [
    question.question,
    ...options.map(
      (o, i) =>
        `${index === i && !editing ? "▸" : " "} ${i + 1}. ${o.label}${o.recommended ? " (Recommended)" : ""}\n   ${o.description}`,
    ),
    ...(options.length ? [`${index === options.length ? "▸" : " "} Other: write your answer`] : []),
    ...(question.recommendationReason ? [`Recommendation: ${question.recommendationReason}`] : []),
  ].join("\n\n");
  const lines = wrapAnsi(terminalText(description, true), Math.max(10, columns - 8), {
    hard: true,
    trim: false,
  }).split("\n");
  const capacity = Math.max(3, Math.min(22, rows - 16));
  const start = Math.min(offset, Math.max(0, lines.length - capacity));
  function answer(text: string) {
    if (submitted.current || !text.trim()) return;
    answers.current[question.id] = text.trim();
    if (number + 1 === request.questions.length) {
      submitted.current = true;
      onAnswer(answers.current);
    } else {
      setNumber((n) => n + 1);
      setIndex(0);
      setFreeText(false);
      setValue("");
      setOffset(0);
    }
  }
  useInput((_input, key) => {
    if (submitted.current) return;
    if (key.escape) {
      submitted.current = true;
      onAnswer();
    } else if (key.pageDown)
      setOffset((v) => Math.min(Math.max(0, lines.length - capacity), v + capacity));
    else if (key.pageUp) setOffset((v) => Math.max(0, v - capacity));
    else if (!editing && (key.upArrow || key.downArrow || key.tab)) {
      setIndex((v) => (v + (key.upArrow ? options.length : 1)) % (options.length + 1));
    } else if (!editing && key.return) {
      if (index === options.length) setFreeText(true);
      else answer(`${options[index].label}: ${options[index].description}`);
    }
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.accent} paddingX={1}>
      <Text bold>
        CAMPAIGN QUESTION {number + 1}/{request.questions.length}
      </Text>
      {lines.slice(start, start + capacity).map((line, n) => (
        <Text key={start + n}>{line}</Text>
      ))}
      {lines.length > capacity && (
        <Text color={palette.dim}>
          Lines {start + 1}–{start + capacity} of {lines.length} · PgUp/PgDn
        </Text>
      )}
      {editing ? (
        <Box>
          <Text>Answer: </Text>
          <TextInput
            value={value}
            onChange={(v) => setValue(v.slice(0, 10000))}
            onSubmit={answer}
          />
        </Box>
      ) : (
        <Text color={palette.accent}>
          Selected: {index === options.length ? "Other" : options[index].label}
        </Text>
      )}
      <Text color={palette.dim}>
        {editing ? "Enter to send" : "↑↓ to select · Enter to answer"} · Esc stops this planning
        turn
      </Text>
    </Box>
  );
}
