CREATE AGENT CONTEXT retail_analytics_context
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY retail.average_net_revenue_retention_pacific
  DESCRIPTION 'Return the privacy-suppressed average net-to-gross revenue retention rate for Pacific orders assigned to the trusted manager.'
  RETURNS HINT 'Returns one scalar average in basis points or a suppression result; never order rows.'
  USING CONTEXT retail_analytics_context
  SOURCE retail_postgres
  ON public.reviewed_order_performance
  PRIMARY KEY order_id
  TENANT KEY merchant_id
  PRINCIPAL SCOPE KEY assigned_manager_id
  AGGREGATE READ AVG net_revenue_retention_basis_points
  SELECT WHERE region_id = 'region-pacific'
  MIN GROUP SIZE 5
  REQUIRE EVIDENCE
END
