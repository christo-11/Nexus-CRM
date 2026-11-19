from flask_mail import Mail
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()
mail = Mail()
limiter = Limiter(key_func=get_remote_address, default_limits=["1000 per hour"])
