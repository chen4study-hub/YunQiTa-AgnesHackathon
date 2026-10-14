"""Source protocol shared by exports and HTTP consumers."""
from dataclasses import dataclass
from datetime import date
from typing import Any, Protocol


@dataclass(frozen=True)
class OpsDayKey:
    scenario: str
    source_date: date
    building_id: str = 'Hog_office_Byron'


class OpsSource(Protocol):
    def read_day(self, key: OpsDayKey) -> dict[str, Any]: ...
    def read_floors(self, key: OpsDayKey, meta: dict[str, Any]) -> dict[str, Any]: ...
    def connections(self, key: OpsDayKey) -> list[dict[str, Any]]: ...
