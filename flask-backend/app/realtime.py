import logging
import time

from flask import current_app, request
from flask_jwt_extended import decode_token
from flask_jwt_extended.exceptions import JWTExtendedException
from flask_socketio import disconnect, join_room

from .extensions import db
from .models import RevokedToken, User

_socketio = None
logger = logging.getLogger(__name__)


def emit_to_user(user_id, event, payload):
    if _socketio:
        _socketio.emit(event, payload, to=f"user:{user_id}")


def emit_to_department(department_id, event, payload):
    if _socketio:
        _socketio.emit(event, payload, to=f"department:{department_id}")


def emit_to_admins(event, payload):
    if _socketio:
        _socketio.emit(event, payload, to="admins")


def register_socket_handlers(socketio):
    global _socketio
    _socketio = socketio

    @socketio.on("connect", namespace="/")
    def on_connect(auth=None):
        token = auth.get("token") if isinstance(auth, dict) else None
        if not token:
            return disconnect()
        try:
            claims = decode_token(token)
        except JWTExtendedException:
            return disconnect()
        try:
            user_id = claims.get("sub")
            if claims.get("type") != "access" or not str(user_id).isdigit():
                return disconnect()
            user = db.session.get(User, int(user_id))
            if (
                not user
                or not user.is_active
                or claims.get("token_version") != user.token_version
                or db.session.get(RevokedToken, claims.get("jti"))
            ):
                return disconnect()
        except Exception:
            logger.exception("Socket.IO connection authentication failed.")
            return disconnect()
        join_room(f"user:{user.id}")
        user_id = user.id
        token_id = claims["jti"]
        token_version = user.token_version
        expires_at = claims["exp"]
        if user.department_id:
            join_room(f"department:{user.department_id}")
        if user.role.name == "MAIN_ADMIN":
            join_room("admins")
        app = current_app._get_current_object()
        socketio.start_background_task(
            monitor_session, app, request.sid, user_id, token_id, token_version, expires_at,
        )

    def monitor_session(app, sid, user_id, token_id, token_version, expires_at):
        while time.time() < expires_at:
            socketio.sleep(min(30, max(1, expires_at - time.time())))
            with app.app_context():
                user = db.session.get(User, user_id)
                revoked = db.session.get(RevokedToken, token_id)
                invalid = (
                    not user
                    or not user.is_active
                    or user.token_version != token_version
                    or revoked is not None
                )
                db.session.remove()
            if invalid:
                socketio.server.disconnect(sid, namespace="/")
                return
        socketio.server.disconnect(sid, namespace="/")
