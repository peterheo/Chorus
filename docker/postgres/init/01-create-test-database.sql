-- chorus_dev is created by POSTGRES_DB. Integration tests connect here and create
-- one throwaway database per test file, so tests never share state.
CREATE DATABASE chorus_test;
