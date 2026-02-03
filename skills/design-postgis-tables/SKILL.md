---
name: design-postgis-tables
description: Comprehensive PostGIS spatial table design reference covering geometry types, coordinate systems, spatial indexing, and performance patterns for location-based applications
---

# PostGIS Spatial Table Design

## Before You Start (5 Questions)

1. What is the geographic scope (single city/region vs global)?
2. What are your primary query patterns (within-radius, bbox, intersects, nearest-neighbor)?
3. What units do you need for distance/area (meters vs CRS units), and how accurate must they be?
4. What is the expected scale (rows, write rate), and is the data mostly append-only?
5. Do you need 3D (Z) or measures (M), or is 2D enough?

**SQL injection note:** When turning these patterns into application code, use parameterized queries for user-provided values (WKT/WKB, coordinates, IDs, radii). Avoid string-concatenating untrusted input into SQL; for dynamic identifiers, use safe identifier quoting/whitelisting.

## Core Rules

- **Always use PostGIS geometry/geography types** instead of PostgreSQL's built-in geometric types (`POINT`, `LINE`, `POLYGON`, `CIRCLE`). PostGIS types provide true spatial capabilities.
- **Choose between GEOMETRY and GEOGRAPHY** based on your use case: GEOMETRY for projected/local data with Cartesian math; GEOGRAPHY for global data requiring accurate spherical calculations.
- **Always specify SRID** (Spatial Reference Identifier) when creating geometry columns. Use `4326` (WGS84) for GPS/global data, appropriate local projections for regional data.
- **Create spatial indexes** on all geometry/geography columns using GiST (default). Consider BRIN only for very large **GEOMETRY** tables where rows are naturally ordered on disk and you can tolerate coarser filtering.
- **Use constraint-based type enforcement** with `GEOMETRY(type, SRID)` syntax to ensure data integrity.

## Geometry vs Geography

### When to Use GEOMETRY

- **Local/regional data** within a single coordinate system
- **Projected coordinates** (meters, feet) for accurate area/distance calculations
- **Complex spatial operations** (buffering, unions, intersections)
- **Performance-critical queries** (Cartesian math is faster)
- **Data already in a projected CRS** (UTM, State Plane, etc.)

```sql
-- Regional data with projected coordinates (UTM Zone 10N for California)
CREATE TABLE local_parcels (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parcel_number TEXT NOT NULL,
    boundary GEOMETRY(POLYGON, 26910),  -- UTM Zone 10N (meters)
    area_sqm DOUBLE PRECISION GENERATED ALWAYS AS (ST_Area(boundary)) STORED
);
```

### When to Use GEOGRAPHY

- **Global data** spanning multiple continents/hemispheres
- **GPS coordinates** (latitude/longitude in decimal degrees)
- **Accurate distance calculations** on Earth's surface (great circle)
- **Simple spatial operations** (distance, containment)
- **Data from GPS devices, geocoding services, or web maps**

```sql
-- Global data with geodetic calculations
CREATE TABLE global_offices (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    city TEXT NOT NULL,
    location GEOGRAPHY(POINT, 4326)  -- WGS84 (lat/lon)
);

-- Distance in meters (accurate spherical calculation)
SELECT
    a.name AS office_a,
    b.name AS office_b,
    ST_Distance(a.location, b.location) / 1000 AS distance_km
FROM global_offices a
CROSS JOIN global_offices b
WHERE a.id < b.id;
```

### Comparison Table

| Aspect            | GEOMETRY                              | GEOGRAPHY                 |
| ----------------- | ------------------------------------- | ------------------------- |
| Coordinate system | Any SRID (projected or geodetic)      | WGS84 (SRID 4326) only    |
| Distance units    | CRS units (degrees, meters, feet)     | Meters (always)           |
| Distance accuracy | Depends on projection                 | True spheroidal distance  |
| Area accuracy     | Accurate in projected CRS             | Accurate on sphere        |
| Function support  | Full (300+ functions)                 | Limited (~40 functions)   |
| Performance       | Faster (Cartesian math)               | Slower (spherical math)   |
| Index type        | GiST, BRIN, SP-GiST                   | GiST only                 |
| Best for          | Regional/local data, complex analysis | Global data, GPS tracking |

## Geometry Types

### Point Types

```sql
-- Single location (stores, sensors, events)
location GEOMETRY(POINT, 4326)

-- Multiple discrete locations (multi-branch business)
locations GEOMETRY(MULTIPOINT, 4326)

-- 3D point with elevation
location_3d GEOMETRY(POINTZ, 4326)

-- Point with measure value (linear referencing)
location_m GEOMETRY(POINTM, 4326)
```

**Use POINT for:** Store locations, sensor positions, event coordinates, addresses, POIs
**Use MULTIPOINT for:** Multiple related locations stored as single feature

### Line Types

```sql
-- Single path (road segment, river, route)
path GEOMETRY(LINESTRING, 4326)

-- Multiple paths (road network, transit lines)
network GEOMETRY(MULTILINESTRING, 4326)

-- 3D line with elevation profile
trail_3d GEOMETRY(LINESTRINGZ, 4326)
```

**Use LINESTRING for:** Roads, rivers, pipelines, GPS tracks, routes
**Use MULTILINESTRING for:** Disconnected road segments, river systems

### Polygon Types

```sql
-- Single area (parcel, building footprint, zone)
boundary GEOMETRY(POLYGON, 4326)

-- Multiple areas (archipelago, fragmented habitat)
territories GEOMETRY(MULTIPOLYGON, 4326)

-- 3D polygon (building with height)
footprint_3d GEOMETRY(POLYGONZ, 4326)
```

**Use POLYGON for:** Property boundaries, administrative areas, service zones
**Use MULTIPOLYGON for:** Countries with islands, fragmented regions

### Generic Types

```sql
-- Any geometry type (flexible schema)
geom GEOMETRY(GEOMETRY, 4326)

-- Collection of mixed types
features GEOMETRY(GEOMETRYCOLLECTION, 4326)
```

**Use GEOMETRY for:** Flexible schemas accepting multiple types
**Avoid GEOMETRYCOLLECTION:** Prefer homogeneous types for better indexing

## Coordinate Systems (SRID)

### Common SRIDs

| SRID        | Name              | Use Case                     | Units   |
| ----------- | ----------------- | ---------------------------- | ------- |
| 4326        | WGS84             | GPS, global data, web maps   | Degrees |
| 3857        | Web Mercator      | Web map tiles (display only) | Meters  |
| 26910-26919 | UTM Zones (US)    | Regional analysis            | Meters  |
| 32601-32660 | UTM Zones (North) | Regional analysis            | Meters  |
| 32701-32760 | UTM Zones (South) | Regional analysis            | Meters  |

### SRID Best Practices

- **Store in WGS84 (4326)** for interoperability and GPS data
- **Transform to projected CRS** for accurate measurements
- **Never mix SRIDs** in spatial operations without explicit transformation
- **Use appropriate local CRS** for area/distance calculations requiring high precision

```sql
-- Store in WGS84, calculate in UTM
CREATE TABLE survey_points (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    location GEOMETRY(POINT, 4326),  -- Storage: WGS84
    CONSTRAINT valid_location CHECK (ST_IsValid(location))
);

-- Calculate distance in meters using UTM projection
SELECT
    a.id AS point_a,
    b.id AS point_b,
    ST_Distance(
        ST_Transform(a.location, 26910),  -- Transform to UTM
        ST_Transform(b.location, 26910)
    ) AS distance_meters
FROM survey_points a
CROSS JOIN survey_points b
WHERE a.id < b.id;
```

## Spatial Indexing

### GiST Index (Default)

Most versatile spatial index. Use for all geometry/geography columns.

```sql
-- Geometry (most common)
CREATE INDEX idx_your_table_geom_gist ON your_table_name USING GIST (geom);

-- Geography (GiST is the supported option)
CREATE INDEX idx_your_table_geog_gist ON your_table_name USING GIST (geog);

-- Analyze after index creation
VACUUM ANALYZE your_table_name;
```

**Supports:** All spatial operators (`&&`, `@>`, `<@`, `~=`, `<->`)
**Best for:** General-purpose spatial queries, mixed query patterns

### BRIN Index

Block Range Index for very large, naturally ordered datasets.

```sql
-- BRIN for very large, append-only GEOMETRY tables (geography uses GiST)
CREATE INDEX idx_your_table_geom_brin
    ON your_table_name
    USING BRIN (geom)
    WITH (pages_per_range = 128);
```

**Supports:** Bounding box operators (`&&`, `@>`, `<@`)
**Best for:** Append-only tables, time-series spatial data, very large datasets (>100M rows)
**Trade-off:** Much smaller than GiST, but less precise filtering

### SP-GiST Index

Space-partitioned GiST for point data with specific distributions.

```sql
-- SP-GiST for GEOMETRY(POINT, ...) only
CREATE INDEX idx_sensors_location_spgist
    ON sensors
    USING SPGIST (location);
```

**Best for:** Point-only data, quadtree-friendly distributions
**Not for:** Complex geometries, mixed types

### Index Selection Guide

| Scenario                         | Index Type    | Reasoning                                  |
| -------------------------------- | ------------- | ------------------------------------------ |
| General spatial queries          | GiST          | Most versatile, supports all operators     |
| Very large, append-only          | BRIN          | Tiny footprint, good for time-ordered data |
| Point-only, uniform distribution | SP-GiST       | Efficient for point lookups                |
| Geography columns                | GiST          | Only supported option                      |
| Composite spatial + attribute    | GiST + B-tree | Separate indexes or expression index       |

## Table Design Examples

### Points of Interest (POI)

```sql
CREATE TABLE pois (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    location GEOGRAPHY(POINT, 4326) NOT NULL,
    address TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT valid_category CHECK (category IN (
        'restaurant', 'hotel', 'gas_station', 'hospital', 'school'
    ))
);

-- Spatial index
CREATE INDEX idx_pois_location ON pois USING GIST (location);

-- Category + location for filtered spatial queries
CREATE INDEX idx_pois_category ON pois (category);

-- Find restaurants within 1km
SELECT name, address,
       ST_Distance(
         location,
         ST_SetSRID(ST_MakePoint(-122.4194, 37.7749), 4326)::GEOGRAPHY
       ) AS distance_m
FROM pois
WHERE category = 'restaurant'
  AND ST_DWithin(
    location,
    ST_SetSRID(ST_MakePoint(-122.4194, 37.7749), 4326)::GEOGRAPHY,
    1000
  )
ORDER BY distance_m;
```

### Property Parcels

```sql
CREATE TABLE parcels (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parcel_id TEXT NOT NULL UNIQUE,
    owner_name TEXT,
    boundary GEOMETRY(MULTIPOLYGON, 4326) NOT NULL,
    centroid GEOMETRY(POINT, 4326) GENERATED ALWAYS AS (ST_Centroid(boundary)) STORED,
    area_sqm DOUBLE PRECISION GENERATED ALWAYS AS (
        ST_Area(boundary::GEOGRAPHY)
    ) STORED,
    perimeter_m DOUBLE PRECISION GENERATED ALWAYS AS (
        ST_Perimeter(boundary::GEOGRAPHY)
    ) STORED,
    CONSTRAINT valid_boundary CHECK (ST_IsValid(boundary)),
    CONSTRAINT closed_boundary CHECK (ST_IsClosed(ST_ExteriorRing(ST_GeometryN(boundary, 1))))
);

CREATE INDEX idx_parcels_boundary ON parcels USING GIST (boundary);
CREATE INDEX idx_parcels_centroid ON parcels USING GIST (centroid);

-- Find parcels intersecting a search area
SELECT parcel_id, owner_name, area_sqm
FROM parcels
WHERE ST_Intersects(boundary, ST_MakeEnvelope(-122.5, 37.7, -122.4, 37.8, 4326));
```

### GPS Tracking

```sql
CREATE TABLE gps_tracks (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id TEXT NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    location GEOGRAPHY(POINT, 4326) NOT NULL,
    speed_kmh DOUBLE PRECISION,
    heading DOUBLE PRECISION,
    accuracy_m DOUBLE PRECISION
);

-- Composite index for device + time queries
CREATE INDEX idx_gps_device_time ON gps_tracks (device_id, recorded_at DESC);

-- Spatial index for location queries
CREATE INDEX idx_gps_location ON gps_tracks USING GIST (location);

-- Note: GEOGRAPHY supports GiST; BRIN is for GEOMETRY (when appropriate).

-- Create linestring from track points
SELECT
    device_id,
    ST_MakeLine(location::GEOMETRY ORDER BY recorded_at) AS track_line,
    MIN(recorded_at) AS start_time,
    MAX(recorded_at) AS end_time
FROM gps_tracks
WHERE device_id = 'device_001'
  AND recorded_at >= '2024-01-01'
GROUP BY device_id;
```

### Service Areas / Coverage Zones

```sql
CREATE TABLE service_zones (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    zone_name TEXT NOT NULL,
    zone_type TEXT NOT NULL,
    boundary GEOMETRY(POLYGON, 4326) NOT NULL,
    population INTEGER,
    active BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT valid_zone_type CHECK (zone_type IN ('delivery', 'service', 'coverage')),
    CONSTRAINT valid_boundary CHECK (ST_IsValid(boundary))
);

CREATE INDEX idx_zones_boundary ON service_zones USING GIST (boundary);
CREATE INDEX idx_zones_active ON service_zones (active) WHERE active = true;

-- Check if location is within any active service zone
SELECT zone_name, zone_type
FROM service_zones
WHERE active = true
  AND ST_Contains(boundary, ST_SetSRID(ST_MakePoint(-122.4194, 37.7749), 4326));
```

## Performance Patterns

### Use ST_DWithin Instead of ST_Distance

```sql
-- SLOW: calculates distance for all rows
SELECT * FROM pois
WHERE ST_Distance(location, ref_point) < 1000;

-- FAST: uses spatial index
SELECT * FROM pois
WHERE ST_DWithin(location, ref_point, 1000);
```

### Use && for Bounding Box Pre-filtering

```sql
-- Bounding box operator leverages spatial index
SELECT * FROM parcels
WHERE boundary && ST_MakeEnvelope(-122.5, 37.7, -122.4, 37.8, 4326)
  AND ST_Intersects(boundary, search_polygon);
```

### Avoid Functions on Indexed Columns

```sql
-- SLOW: function prevents index usage
SELECT * FROM parcels WHERE ST_Area(boundary) > 10000;

-- FAST: use generated column with regular index
ALTER TABLE parcels ADD COLUMN area_sqm DOUBLE PRECISION
    GENERATED ALWAYS AS (ST_Area(boundary::GEOGRAPHY)) STORED;
CREATE INDEX idx_parcels_area ON parcels (area_sqm);
SELECT * FROM parcels WHERE area_sqm > 10000;
```

### Simplify Geometries for Display

```sql
-- Reduce complexity for web display (tolerance in CRS units)
SELECT
    id,
    name,
    ST_AsGeoJSON(ST_Simplify(boundary, 0.0001)) AS geojson
FROM parcels;
```

### Use Appropriate Precision

```sql
-- Reduce coordinate precision for storage efficiency
UPDATE locations SET geom = ST_ReducePrecision(geom, 0.000001);

-- GeoJSON with limited decimal places
SELECT ST_AsGeoJSON(location, 6) AS geojson FROM pois;
```

## Data Validation

### Geometry Validity Checks

```sql
-- Add validity constraint
ALTER TABLE parcels ADD CONSTRAINT valid_geom CHECK (ST_IsValid(boundary));

-- Find and fix invalid geometries
SELECT id, ST_IsValidReason(boundary) AS reason
FROM parcels
WHERE NOT ST_IsValid(boundary);

-- Attempt to fix invalid geometries
UPDATE parcels
SET boundary = ST_MakeValid(boundary)
WHERE NOT ST_IsValid(boundary);
```

### SRID Consistency

```sql
-- Verify SRID consistency
SELECT DISTINCT ST_SRID(geom) FROM spatial_table;

-- Enforce SRID with constraint
ALTER TABLE locations ADD CONSTRAINT enforce_srid
    CHECK (ST_SRID(location) = 4326);
```

### Coordinate Range Validation

```sql
-- Ensure coordinates are within valid WGS84 bounds
ALTER TABLE global_locations ADD CONSTRAINT valid_coords CHECK (
    ST_X(location::GEOMETRY) BETWEEN -180 AND 180 AND
    ST_Y(location::GEOMETRY) BETWEEN -90 AND 90
);
```

## Do Not Use

- **PostgreSQL built-in types** (`POINT`, `LINE`, `POLYGON`, `CIRCLE`) - use PostGIS types instead
- **SRID 0** (undefined) - always specify the correct SRID
- **ST_Distance for filtering** - use ST_DWithin for index-supported distance queries
- **Mixed SRIDs** in operations - always transform to common SRID first
- **GEOGRAPHY for complex analysis** - use GEOMETRY with appropriate projection
- **Over-precise coordinates** - GPS accuracy is ~3-5m, 6 decimal places (0.1m) is sufficient

## Common Pitfalls

1. **Longitude/Latitude order**: PostGIS uses `(longitude, latitude)` = `(X, Y)`, not `(lat, lon)`
2. **GEOGRAPHY distance units**: Always in meters, regardless of display
3. **Index not used**: Run `EXPLAIN ANALYZE` to verify spatial index usage
4. **Transform performance**: Cache transformed geometries for repeated queries
5. **Large geometries**: Consider ST_Subdivide for very complex polygons
6. **SQL injection / unsafe dynamic SQL**: Don't concatenate untrusted input into SQL. Parameterize values; for dynamic identifiers use safe quoting (`quote_ident`, `format('%I', ...)`) or strict allowlists.
