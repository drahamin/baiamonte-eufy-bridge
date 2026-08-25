"""Authenticated HomeBase evidence media endpoints."""

from __future__ import annotations

import asyncio

import aiohttp
from aiohttp import web
from homeassistant.components.http import KEY_HASS, HomeAssistantView
from homeassistant.core import HomeAssistant


class EvidenceThumbnailView(HomeAssistantView):
    """Serve an indexed HomeBase thumbnail to authenticated HA users."""

    url = "/api/baiamonte_eufy/evidence/{event_id}/thumbnail"
    name = "api:baiamonte_eufy:evidence:thumbnail"
    requires_auth = True

    def __init__(self, coordinator_getter) -> None:
        self._coordinator_getter = coordinator_getter

    async def get(self, request: web.Request, event_id: str) -> web.Response:
        try:
            content, content_type = await self._coordinator_getter(
                request.app[KEY_HASS]
            ).evidence_thumbnail(event_id)
        except KeyError as exc:
            raise web.HTTPNotFound(text="Search for the event again") from exc
        except (ValueError, RuntimeError, asyncio.TimeoutError) as exc:
            raise web.HTTPBadRequest(text=str(exc)) from exc
        return web.Response(
            body=content,
            content_type=content_type,
            headers={"Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff"},
        )


class EvidenceVideoView(HomeAssistantView):
    """Serve a remuxed HomeBase recording to authenticated HA users."""

    url = "/api/baiamonte_eufy/evidence/{event_id}/video"
    name = "api:baiamonte_eufy:evidence:video"
    requires_auth = True

    def __init__(self, coordinator_getter) -> None:
        self._coordinator_getter = coordinator_getter

    async def get(self, request: web.Request, event_id: str) -> web.Response:
        try:
            content = await self._coordinator_getter(
                request.app[KEY_HASS]
            ).evidence_video(event_id)
        except KeyError as exc:
            raise web.HTTPNotFound(text="Search for the event again") from exc
        except RuntimeError as exc:
            raise web.HTTPConflict(text=str(exc)) from exc
        except (ValueError, asyncio.TimeoutError) as exc:
            raise web.HTTPBadRequest(text=str(exc)) from exc
        headers = {
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=300",
            "Content-Disposition": 'inline; filename="eufy-event.mp4"',
            "X-Content-Type-Options": "nosniff",
        }
        range_header = request.headers.get("Range")
        if range_header and range_header.startswith("bytes="):
            try:
                start_text, end_text = range_header[6:].split("-", 1)
                start = int(start_text) if start_text else 0
                end = int(end_text) if end_text else len(content) - 1
                if start < 0 or end < start or start >= len(content):
                    raise ValueError
                end = min(end, len(content) - 1)
            except ValueError as exc:
                raise web.HTTPRequestRangeNotSatisfiable() from exc
            headers["Content-Range"] = f"bytes {start}-{end}/{len(content)}"
            return web.Response(
                body=content[start : end + 1],
                status=206,
                content_type="video/mp4",
                headers=headers,
            )
        return web.Response(body=content, content_type="video/mp4", headers=headers)


class EvidenceAIImageView(HomeAssistantView):
    """Serve a proxied AI face/crop image to authenticated HA users."""

    url = "/api/baiamonte_eufy/evidence/{event_id}/ai/{index}"
    name = "api:baiamonte_eufy:evidence:ai-image"
    requires_auth = True

    def __init__(self, coordinator_getter) -> None:
        self._coordinator_getter = coordinator_getter

    async def get(
        self, request: web.Request, event_id: str, index: str
    ) -> web.Response:
        try:
            content, content_type = await self._coordinator_getter(
                request.app[KEY_HASS]
            ).evidence_ai_image(event_id, int(index))
        except KeyError as exc:
            raise web.HTTPNotFound(text="Search for the event again") from exc
        except (
            ValueError,
            RuntimeError,
            aiohttp.ClientError,
            asyncio.TimeoutError,
        ) as exc:
            raise web.HTTPBadRequest(text=str(exc)) from exc
        return web.Response(
            body=content,
            content_type=content_type,
            headers={
                "Cache-Control": "private, max-age=300",
                "X-Content-Type-Options": "nosniff",
            },
        )


def register_evidence_views(hass: HomeAssistant, coordinator_getter) -> None:
    """Register the protected media routes once."""
    hass.http.register_view(EvidenceThumbnailView(coordinator_getter))
    hass.http.register_view(EvidenceVideoView(coordinator_getter))
    hass.http.register_view(EvidenceAIImageView(coordinator_getter))
