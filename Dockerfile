FROM python:3.11-slim

WORKDIR /app

# Copy application code, static frontend, and initial seed data
COPY po_engine.py server.py ./
COPY static/ ./static/
COPY data/ ./data/

# Cloud Run sets PORT=8080 and K_SERVICE automatically.
# When a GCS bucket is mounted at /app/persistent_data, PO_DATA_DIR points there
# and po_engine.py automatically seeds bjj_tabs_config.json on first boot.
ENV PORT=8080
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

EXPOSE 8080

CMD ["python", "server.py"]
