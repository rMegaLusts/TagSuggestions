import json
import os
import time

import httpx

from decision_tagger.errors import TaggingError
from decision_tagger.models import AskResult, Config


class RetryableError(Exception):
    pass


class SystemOneClient:
    def __init__(
        self,
        config: Config,
        *,
        api_key: str | None = None,
        http: httpx.Client | None = None,
        sleeper=time.sleep,
    ):
        self._config = config
        self._sleeper = sleeper
        resolved = api_key
        if resolved is None and config.api_key_env:
            resolved = os.environ.get(config.api_key_env)
        if resolved is not None and not str(resolved).strip():
            resolved = None
        self._headers = {"Authorization": f"Bearer {resolved}"} if resolved else {}
        if http is None:
            self._http = httpx.Client(
                base_url=config.server_url.rstrip("/"),
                timeout=config.timeout_seconds,
            )
            self._owns_http = True
        else:
            self._http = http
            self._owns_http = False

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    def ask(self, state: dict, questions: dict[str, dict]) -> AskResult:
        payload: dict = {"state": state, "questions": questions}
        if self._config.model:
            payload["model"] = self._config.model
        delay = self._config.retry_backoff_seconds
        attempts = self._config.max_retries + 1
        last: Exception | None = None
        for attempt in range(attempts):
            try:
                response = self._post(payload)
                return self._parse(response, questions)
            except RetryableError as exc:
                last = exc
                if attempt + 1 == attempts:
                    break
                self._sleeper(delay)
                delay *= 2
        raise TaggingError(f"system one request failed: {last}") from last

    def _post(self, payload: dict) -> httpx.Response:
        try:
            response = self._http.post("/v1/systemone", json=payload, headers=self._headers)
        except httpx.TransportError as exc:
            raise RetryableError(str(exc)) from exc
        if response.status_code == 429 or response.status_code >= 500:
            raise RetryableError(f"HTTP {response.status_code}: {response.text[:500]}")
        if response.status_code >= 400:
            raise TaggingError(f"HTTP {response.status_code}: {response.text[:500]}")
        return response

    def _parse(self, response: httpx.Response, questions: dict[str, dict]) -> AskResult:
        try:
            payload = response.json()
        except json.JSONDecodeError as exc:
            raise TaggingError("system one returned invalid JSON") from exc
        answers = payload.get("answers")
        if not isinstance(answers, dict):
            raise TaggingError("system one response has no answers")
        scores: dict[str, float] = {}
        for question_id in questions:
            answer = answers.get(question_id)
            if not isinstance(answer, dict) or "noul" not in answer:
                raise TaggingError(f"missing noul answer for {question_id}")
            try:
                scores[question_id] = float(answer["noul"])
            except (TypeError, ValueError) as exc:
                raise TaggingError(f"invalid noul answer for {question_id}") from exc
        usage = payload.get("usage") or {}
        tokens = int(usage.get("input_tokens") or 0)
        return AskResult(scores=scores, input_tokens=tokens)
