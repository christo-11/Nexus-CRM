FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN useradd --create-home appuser && mkdir -p instance/uploads && chown -R appuser:appuser /app
USER appuser
EXPOSE 8000
CMD ["gunicorn", "--worker-class", "gthread", "--workers", "1", "--threads", "100", "--timeout", "240", "--bind", "0.0.0.0:8000", "app:create_app()"]
